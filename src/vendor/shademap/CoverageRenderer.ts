import type mapboxgl from "mapbox-gl";
import type { AnalysisRequest, DebugMode, LinkProfile } from "../../types";
import {
  haversineDistanceM,
  lngLatToMercator01,
  mercator01ToLngLat,
  metersToMercatorUnits,
} from "../../analysis/coordinates";
import { linkMarginDb } from "../../analysis/rf";

const textureSize = 160;
const raySteps = 28;

const vertexSource = `
precision highp float;

attribute vec2 a_mercator;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_mercator, 0.0, 1.0);
}`;

const fragmentSource = `
precision highp float;

varying vec2 v_uv;
uniform sampler2D u_coverage;

void main() {
  gl_FragColor = texture2D(u_coverage, v_uv);
}`;

type CoverageBuild = {
  data: Uint8Array;
  terrainSamples: number;
};

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compilation failed");
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Unable to create WebGL program");
  }
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Program link failed");
  }
  return program;
}

function profileBudget(profile: LinkProfile): number {
  return (
    profile.txPowerDbm +
    profile.txGainDbi -
    profile.txLossDb +
    profile.rxGainDbi -
    profile.rxLossDb -
    profile.rxSensitivityDbm -
    profile.requiredMarginDb
  );
}

function altitudeColor(requiredAltitudeM: number, request: AnalysisRequest): [number, number, number] {
  const t = Math.max(
    0,
    Math.min(
      1,
      (requiredAltitudeM - request.altitude.minM) /
        Math.max(1, request.altitude.maxM - request.altitude.minM),
    ),
  );
  if (t < 0.55) {
    const k = t / 0.55;
    return [
      Math.round(13 + (242 - 13) * k),
      Math.round(184 + (194 - 184) * k),
      Math.round(107 + (56 - 107) * k),
    ];
  }
  const k = (t - 0.55) / 0.45;
  return [
    Math.round(242 + (230 - 242) * k),
    Math.round(194 + (46 - 194) * k),
    Math.round(56 + (38 - 56) * k),
  ];
}

function marginColor(marginDb: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (marginDb + 12) / 36));
  return [
    Math.round(217 + (26 - 217) * t),
    Math.round(26 + (191 - 26) * t),
    Math.round(20 + (71 - 20) * t),
  ];
}

export class CoverageRenderer {
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private texture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private attribMercator: number;
  private attribUv: number;
  private dirty = true;
  private lastTerrainSamples = 0;

  constructor(private readonly gl: WebGLRenderingContext) {
    this.program = createProgram(gl);
    this.buffer = gl.createBuffer()!;
    this.texture = gl.createTexture()!;
    this.attribMercator = gl.getAttribLocation(this.program, "a_mercator");
    this.attribUv = gl.getAttribLocation(this.program, "a_uv");
    this.uniforms = {
      u_matrix: gl.getUniformLocation(this.program, "u_matrix"),
      u_coverage: gl.getUniformLocation(this.program, "u_coverage"),
    };

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      textureSize,
      textureSize,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(textureSize * textureSize * 4),
    );
  }

  markDirty(): void {
    this.dirty = true;
  }

  render(map: mapboxgl.Map, request: AnalysisRequest, debugMode: DebugMode, matrix: number[]): void {
    const gl = this.gl;
    const operator = lngLatToMercator01(request.operator.lng, request.operator.lat);
    const radiusMercator = metersToMercatorUnits(request.radiusM, request.operator.lat);

    if (this.dirty) {
      const build = this.buildCoverage(map, request, debugMode, operator, radiusMercator);
      this.lastTerrainSamples = build.terrainSamples;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        textureSize,
        textureSize,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        build.data,
      );
      this.dirty = false;
    }

    const minX = operator.x - radiusMercator;
    const maxX = operator.x + radiusMercator;
    const minY = operator.y - radiusMercator;
    const maxY = operator.y + radiusMercator;
    const vertices = new Float32Array([
      minX,
      maxY,
      0,
      0,
      maxX,
      maxY,
      1,
      0,
      minX,
      minY,
      0,
      1,
      minX,
      minY,
      0,
      1,
      maxX,
      maxY,
      1,
      0,
      maxX,
      minY,
      1,
      1,
    ]);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attribMercator);
    gl.vertexAttribPointer(this.attribMercator, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.attribUv);
    gl.vertexAttribPointer(this.attribUv, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.u_coverage, 0);
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, matrix);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteTexture(this.texture);
  }

  private buildCoverage(
    map: mapboxgl.Map,
    request: AnalysisRequest,
    debugMode: DebugMode,
    operator: { x: number; y: number },
    radiusMercator: number,
  ): CoverageBuild {
    const data = new Uint8Array(textureSize * textureSize * 4);
    const selectedProfiles = request.profiles.filter((profile) =>
      request.selectedProfileIds.includes(profile.id),
    );
    const operatorLngLat = { lng: request.operator.lng, lat: request.operator.lat };
    const operatorTerrain = terrainElevation(map, operatorLngLat);
    const operatorAbsM = operatorTerrain + request.operator.antennaHeightM;
    let terrainSamples = Number.isFinite(operatorTerrain) ? 1 : 0;

    for (let y = 0; y < textureSize; y++) {
      for (let x = 0; x < textureSize; x++) {
        const centeredX = (x + 0.5) / textureSize;
        const centeredY = (y + 0.5) / textureSize;
        const dx = centeredX * 2 - 1;
        const dy = centeredY * 2 - 1;
        const unitDistance = Math.hypot(dx, dy);
        const offset = (y * textureSize + x) * 4;

        if (unitDistance > 1) {
          continue;
        }

        const targetMercator = {
          x: operator.x + dx * radiusMercator,
          y: operator.y + dy * radiusMercator,
        };
        const targetLngLat = mercator01ToLngLat(targetMercator);
        const distanceM = haversineDistanceM(operatorLngLat, targetLngLat);
        const targetTerrain = terrainElevation(map, targetLngLat);
        if (Number.isFinite(targetTerrain)) {
          terrainSamples++;
        }

        let requiredAltitudeM = request.altitude.minM;
        let blockerElevationM = -Infinity;

        for (let step = 1; step < raySteps; step++) {
          const t = step / raySteps;
          const sampleMercator = {
            x: operator.x + dx * radiusMercator * t,
            y: operator.y + dy * radiusMercator * t,
          };
          const sampleLngLat = mercator01ToLngLat(sampleMercator);
          const sampleTerrain = terrainElevation(map, sampleLngLat);
          if (!Number.isFinite(sampleTerrain)) {
            continue;
          }
          terrainSamples++;
          blockerElevationM = Math.max(blockerElevationM, sampleTerrain);
          const requiredTargetAbsM = operatorAbsM + (sampleTerrain - operatorAbsM) / t;
          requiredAltitudeM = Math.max(requiredAltitudeM, requiredTargetAbsM - targetTerrain);
        }

        const margins = selectedProfiles.map((profile) => linkMarginDb(distanceM, profile));
        const marginDb = margins.length > 0 ? Math.min(...margins) : 0;
        const reachable =
          distanceM <= request.radiusM &&
          requiredAltitudeM <= request.altitude.maxM &&
          marginDb >= 0;

        let color: [number, number, number];
        if (debugMode === "los") {
          color = requiredAltitudeM <= request.altitude.maxM ? [26, 179, 255] : [242, 242, 242];
        } else if (debugMode === "margin") {
          color = marginColor(marginDb);
        } else if (debugMode === "blocker" || debugMode === "shademap") {
          const t = Math.max(0, Math.min(1, (blockerElevationM - operatorTerrain + 80) / 260));
          color = [Math.round(90 + 130 * t), Math.round(70 + 40 * t), Math.round(170 + 40 * t)];
        } else {
          color = altitudeColor(requiredAltitudeM, request);
        }

        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = reachable || debugMode === "los" || debugMode === "blocker" ? 118 : 0;
      }
    }

    return { data, terrainSamples };
  }

  getTerrainSampleCount(): number {
    return this.lastTerrainSamples;
  }
}

function terrainElevation(map: mapboxgl.Map, lngLat: { lng: number; lat: number }): number {
  const elevation = map.queryTerrainElevation(lngLat, { exaggerated: false });
  return typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
}

export const coverageTextureSize = textureSize;
export const terrainRaySteps = raySteps;
export { profileBudget };
