import {
  analysisMercatorBounds,
  chooseDemZoom,
  coveringDemTiles,
  mapboxTerrainRgbElevationM,
  type DemTileId,
  type MercatorBounds,
} from "./analysis/demTiles";
import { clampGridSize, coverageRaySteps, createCoverageGridSpec } from "./analysis/coverageGrid";
import { analysisRadiusM } from "./analysis/singleRay";
import { combinedMaxFreeSpaceRangeM, maxFreeSpaceRangeM } from "./analysis/rf";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "./types";

type CoverageImageCoordinates = [[number, number], [number, number], [number, number], [number, number]];

export type GpuCoverageImage = {
  canvas: HTMLCanvasElement;
  coordinates: CoverageImageCoordinates;
};

export type GpuCoverageLayerOptions = {
  mapboxToken: string;
  texturePx: number;
  coordinatesForAnalysis: (operator: AnalysisRequest["operator"], radiusM: number) => CoverageImageCoordinates;
};

type DecodedTile = {
  width: number;
  height: number;
  elevations: Float32Array;
};

const vertexShaderSource = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const numericFragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_height;
uniform vec2 u_operatorUv;
uniform float u_antennaHeightM;
uniform float u_minAltitudeM;
uniform float u_maxAltitudeM;
uniform float u_stepAltitudeM;
uniform float u_radiusM;
uniform float u_maxReachM;
uniform int u_raySteps;

in vec2 v_uv;
out vec4 outData;

float heightAt(vec2 uv) {
  return texture(u_height, clamp(uv, vec2(0.0), vec2(1.0))).r;
}

void main() {
  vec2 circle = v_uv * 2.0 - 1.0;
  if (dot(circle, circle) > 1.0) {
    outData = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  float distanceM = length(circle) * u_radiusM;
  float rangePass = distanceM <= u_maxReachM ? 1.0 : 0.0;
  if (distanceM > u_maxReachM) {
    outData = vec4(u_maxAltitudeM + 1.0, 0.0, rangePass, distanceM);
    return;
  }

  float operatorAbsM = heightAt(u_operatorUv) + u_antennaHeightM;
  float targetTerrainM = heightAt(v_uv);
  float requiredTargetAbsM = max(operatorAbsM + u_minAltitudeM, targetTerrainM + u_minAltitudeM);

  for (int step = 1; step < 128; step++) {
    if (step >= u_raySteps) {
      break;
    }
    float t = float(step) / float(u_raySteps);
    vec2 sampleUv = mix(u_operatorUv, v_uv, t);
    float obstacleM = heightAt(sampleUv);
    requiredTargetAbsM = max(requiredTargetAbsM, operatorAbsM + (obstacleM - operatorAbsM) / max(t, 0.001));
  }

  float requiredAltitudeM = requiredTargetAbsM - operatorAbsM;
  float reachable = requiredAltitudeM <= u_maxAltitudeM ? 1.0 : 0.0;
  outData = vec4(requiredAltitudeM, reachable, rangePass, distanceM);
}`;

const shadeFragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_numeric;
uniform float u_minAltitudeM;
uniform float u_maxAltitudeM;
uniform float u_stepAltitudeM;

in vec2 v_uv;
out vec4 outColor;

vec3 ramp(float t) {
  vec3 green = vec3(31.0, 184.0, 88.0) / 255.0;
  vec3 yellow = vec3(247.0, 220.0, 72.0) / 255.0;
  vec3 orange = vec3(242.0, 143.0, 44.0) / 255.0;
  vec3 red = vec3(220.0, 54.0, 46.0) / 255.0;
  if (t < 0.5) {
    return mix(green, yellow, t / 0.5);
  }
  if (t < 0.75) {
    return mix(yellow, orange, (t - 0.5) / 0.25);
  }
  return mix(orange, red, (t - 0.75) / 0.25);
}

void main() {
  vec4 data = texture(u_numeric, v_uv);
  if (data.y < 0.5 || data.z < 0.5) {
    outColor = vec4(0.0);
    return;
  }
  float steppedAltitudeM = u_minAltitudeM + ceil((data.x - u_minAltitudeM) / max(abs(u_stepAltitudeM), 0.001)) * max(abs(u_stepAltitudeM), 0.001);
  float band = clamp((steppedAltitudeM - u_minAltitudeM) / max(u_maxAltitudeM - u_minAltitudeM, 0.001), 0.0, 1.0);
  outColor = vec4(ramp(band), 178.0 / 255.0);
}`;

export class GpuCoverageLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly numericProgram: WebGLProgram;
  private readonly shadeProgram: WebGLProgram;
  private readonly heightTexture: WebGLTexture;
  private readonly numericTexture: WebGLTexture;
  private readonly numericFramebuffer: WebGLFramebuffer;
  private readonly tileCache = new Map<string, Promise<DecodedTile>>();
  private analysis: AnalysisRequest | null = null;
  private debugMode: DebugMode = "combined";
  private bounds: MercatorBounds | null = null;
  private heightData: Float32Array | null = null;
  private demSignature = "";

  static create(options: GpuCoverageLayerOptions): GpuCoverageLayer | null {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
      return null;
    }
    return new GpuCoverageLayer(options, canvas, gl);
  }

  private constructor(
    private readonly options: GpuCoverageLayerOptions,
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this.canvas.width = options.texturePx;
    this.canvas.height = options.texturePx;
    this.numericProgram = createProgram(gl, vertexShaderSource, numericFragmentShaderSource);
    this.shadeProgram = createProgram(gl, vertexShaderSource, shadeFragmentShaderSource);
    const texture = gl.createTexture();
    const numericTexture = gl.createTexture();
    const numericFramebuffer = gl.createFramebuffer();
    if (!texture || !numericTexture || !numericFramebuffer) {
      throw new Error("Unable to allocate GPU height texture");
    }
    this.heightTexture = texture;
    this.numericTexture = numericTexture;
    this.numericFramebuffer = numericFramebuffer;
    this.initNumericTarget();
    this.initGeometry();
  }

  async updateAnalysis(analysis: AnalysisRequest, debugMode: DebugMode): Promise<void> {
    this.analysis = analysis;
    this.debugMode = debugMode;
    const gridSize = clampGridSize(analysis.gridSizePx);
    if (this.canvas.width !== gridSize || this.canvas.height !== gridSize) {
      this.canvas.width = gridSize;
      this.canvas.height = gridSize;
      this.initNumericTarget();
    }
    const radiusM = analysisRadiusM(analysis, debugMode);
    const z = chooseDemZoom(analysis, radiusM);
    const bounds = analysisMercatorBounds(analysis, radiusM);
    const signature = [
      z,
      bounds.west.toFixed(8),
      bounds.north.toFixed(8),
      bounds.east.toFixed(8),
      bounds.south.toFixed(8),
      this.canvas.width,
    ].join(":");

    if (signature === this.demSignature) {
      return;
    }

    this.demSignature = signature;
    this.bounds = bounds;
    this.heightData = await this.buildHeightTexture(bounds, z);
    this.uploadHeightTexture(this.heightData);
  }

  updateHeightFieldForValidation(
    analysis: AnalysisRequest,
    debugMode: DebugMode,
    bounds: MercatorBounds,
    elevations: Float32Array,
  ): void {
    this.analysis = analysis;
    this.debugMode = debugMode;
    const gridSize = clampGridSize(analysis.gridSizePx);
    if (this.canvas.width !== gridSize || this.canvas.height !== gridSize) {
      this.canvas.width = gridSize;
      this.canvas.height = gridSize;
      this.initNumericTarget();
    }
    this.bounds = bounds;
    this.heightData = elevations;
    this.demSignature = "";
    this.uploadHeightTexture(elevations);
  }

  render(): GpuCoverageImage | null {
    if (!this.analysis || !this.bounds || !this.heightData) {
      return null;
    }

    const gl = this.gl;
    const radiusM = analysisRadiusM(this.analysis, this.debugMode);
    const operatorUv = createCoverageGridSpec(this.analysis, this.debugMode).operatorUv;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.numericFramebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.numericProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    setUniform1i(gl, this.numericProgram, "u_height", 0);
    setUniform2f(gl, this.numericProgram, "u_operatorUv", operatorUv.u, operatorUv.v);
    setUniform1f(gl, this.numericProgram, "u_antennaHeightM", this.analysis.operator.antennaHeightM);
    setUniform1f(gl, this.numericProgram, "u_minAltitudeM", this.analysis.altitude.minM);
    setUniform1f(gl, this.numericProgram, "u_maxAltitudeM", this.analysis.altitude.maxM);
    setUniform1f(gl, this.numericProgram, "u_stepAltitudeM", this.analysis.altitude.stepM);
    setUniform1f(gl, this.numericProgram, "u_radiusM", radiusM);
    setUniform1f(gl, this.numericProgram, "u_maxReachM", maxReachM(this.analysis, this.debugMode, radiusM));
    setUniform1i(gl, this.numericProgram, "u_raySteps", coverageRaySteps);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.shadeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.numericTexture);
    setUniform1i(gl, this.shadeProgram, "u_numeric", 0);
    setUniform1f(gl, this.shadeProgram, "u_minAltitudeM", this.analysis.altitude.minM);
    setUniform1f(gl, this.shadeProgram, "u_maxAltitudeM", this.analysis.altitude.maxM);
    setUniform1f(gl, this.shadeProgram, "u_stepAltitudeM", this.analysis.altitude.stepM);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    return {
      canvas: this.canvas,
      coordinates: this.options.coordinatesForAnalysis(this.analysis.operator, radiusM),
    };
  }

  readCoveragePixel(_lngLat: { lng: number; lat: number }): CoveragePixel | null {
    return null;
  }

  dispose(): void {
    this.gl.deleteProgram(this.numericProgram);
    this.gl.deleteProgram(this.shadeProgram);
    this.gl.deleteTexture(this.heightTexture);
    this.gl.deleteTexture(this.numericTexture);
    this.gl.deleteFramebuffer(this.numericFramebuffer);
  }

  readNumericCoverage(): Float32Array {
    const gl = this.gl;
    const output = new Float32Array(this.canvas.width * this.canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.numericFramebuffer);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.FLOAT, output);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return output;
  }

  private async buildHeightTexture(bounds: MercatorBounds, z: number): Promise<Float32Array> {
    const tiles = await Promise.all(coveringDemTiles(bounds, z).map((tile) => this.loadTile(tile)));
    const tileIds = coveringDemTiles(bounds, z);
    const texturePx = this.canvas.width;
    const output = new Float32Array(texturePx * texturePx);
    const scale = 2 ** z;

    for (let y = 0; y < texturePx; y++) {
      const mercatorY = bounds.north + ((y + 0.5) / texturePx) * (bounds.south - bounds.north);
      for (let x = 0; x < texturePx; x++) {
        const mercatorX = bounds.west + ((x + 0.5) / texturePx) * (bounds.east - bounds.west);
        const tileX = Math.max(0, Math.min(scale - 1, Math.floor(mercatorX * scale)));
        const tileY = Math.max(0, Math.min(scale - 1, Math.floor(mercatorY * scale)));
        const tileIndex = tileIds.findIndex((tile) => tile.x === tileX && tile.y === tileY);
        const tile = tiles[tileIndex];
        if (!tile) {
          output[y * texturePx + x] = 0;
          continue;
        }
        const localX = Math.max(0, Math.min(tile.width - 1, Math.floor((mercatorX * scale - tileX) * tile.width)));
        const localY = Math.max(0, Math.min(tile.height - 1, Math.floor((mercatorY * scale - tileY) * tile.height)));
        output[y * texturePx + x] = tile.elevations[localY * tile.width + localX] ?? 0;
      }
    }

    return output;
  }

  private uploadHeightTexture(data: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      this.canvas.width,
      this.canvas.height,
      0,
      gl.RED,
      gl.FLOAT,
      data,
    );
  }

  private loadTile(tile: DemTileId): Promise<DecodedTile> {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = loadTerrainTile(tile, this.options.mapboxToken);
    this.tileCache.set(key, promise);
    return promise;
  }

  private initGeometry(): void {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error("Unable to allocate GPU quad buffer");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(this.numericProgram, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  }

  private initNumericTarget(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.numericTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.numericFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.numericTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("GPU numeric framebuffer is incomplete");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

async function loadTerrainTile(tile: DemTileId, token: string): Promise<DecodedTile> {
  const image = await loadImage(
    `https://api.mapbox.com/v4/mapbox.terrain-rgb/${tile.z}/${tile.x}/${tile.y}.pngraw?access_token=${encodeURIComponent(token)}`,
  );
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Unable to decode DEM tile");
  }
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const elevations = new Float32Array(canvas.width * canvas.height);
  for (let index = 0; index < elevations.length; index++) {
    elevations[index] = mapboxTerrainRgbElevationM(pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]);
  }
  return {
    width: canvas.width,
    height: canvas.height,
    elevations,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load DEM tile: ${url}`));
    image.src = url;
  });
}

function maxReachM(analysis: AnalysisRequest, debugMode: DebugMode, activeRadiusM: number): number {
  if (debugMode === "los" || debugMode === "blocker") {
    return activeRadiusM;
  }

  const profiles = selectedProfilesForMode(analysis, debugMode);
  if (profiles.length === 0) {
    return activeRadiusM;
  }

  const rfRangeM =
    debugMode === "combined"
      ? combinedMaxFreeSpaceRangeM(profiles)
      : profiles[0]
        ? maxFreeSpaceRangeM(profiles[0])
        : activeRadiusM;

  return Math.min(activeRadiusM, rfRangeM || activeRadiusM);
}

function selectedProfilesForMode(analysis: AnalysisRequest, debugMode: DebugMode): LinkProfile[] {
  if (debugMode === "los" || debugMode === "blocker") {
    return [];
  }
  if (debugMode === "control" || debugMode === "telemetry" || debugMode === "video") {
    const profile = analysis.profiles.find((candidate) => candidate.id === debugMode);
    return profile ? [profile] : [];
  }
  return analysis.profiles.filter((profile) => analysis.selectedProfileIds.includes(profile.id));
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Unable to create GPU coverage program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Unable to link GPU coverage program");
  }
  return program;
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to create GPU coverage shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Unable to compile GPU coverage shader");
  }
  return shader;
}

function setUniform1f(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: number): void {
  gl.uniform1f(gl.getUniformLocation(program, name), value);
}

function setUniform1i(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: number): void {
  gl.uniform1i(gl.getUniformLocation(program, name), value);
}

function setUniform2f(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, x: number, y: number): void {
  gl.uniform2f(gl.getUniformLocation(program, name), x, y);
}
