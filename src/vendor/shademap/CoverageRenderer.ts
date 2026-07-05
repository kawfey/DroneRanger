import type { AnalysisRequest, DebugMode, LinkProfile } from "../../types";
import { lngLatToMercator01, metersToMercatorUnits } from "../../analysis/coordinates";

const vertexSource = `#version 300 es
precision highp float;

in vec2 a_pos;
out vec2 v_uv;

void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 out_color;

uniform vec2 u_operator;
uniform float u_radiusMercator;
uniform float u_radiusM;
uniform float u_minAltM;
uniform float u_maxAltM;
uniform float u_antennaHeightM;
uniform int u_debugMode;
uniform int u_selectedMask;
uniform vec4 u_profileFreqMHz;
uniform vec4 u_profileBudgetDb;

float fsplDb(float distanceM, float frequencyMHz) {
  float dKm = max(distanceM, 1.0) / 1000.0;
  return 32.44 + 20.0 * log(dKm) / log(10.0) + 20.0 * log(frequencyMHz) / log(10.0);
}

float profileMargin(float distanceM, int index) {
  return u_profileBudgetDb[index] - fsplDb(distanceM, u_profileFreqMHz[index]);
}

vec3 altitudeRamp(float t) {
  vec3 low = vec3(0.05, 0.72, 0.42);
  vec3 mid = vec3(0.95, 0.76, 0.22);
  vec3 high = vec3(0.9, 0.18, 0.15);
  return mix(mix(low, mid, smoothstep(0.0, 0.55, t)), high, smoothstep(0.45, 1.0, t));
}

void main() {
  vec2 centered = v_uv * 2.0 - 1.0;
  float unitDistance = length(centered);
  if (unitDistance > 1.0) {
    out_color = vec4(0.0);
    return;
  }

  float distanceM = unitDistance * u_radiusM;

  // Placeholder obstacle march: flat terrain and no canopy source produce min altitude.
  // The custom-layer structure mirrors ShadeMap so DEM/obstacle textures can be wired into
  // this radial march without changing the public layer contract.
  float requiredAlt = u_minAltM;
  float minMargin = 9999.0;
  int reachableMask = 0;

  for (int i = 0; i < 3; i++) {
    int bit = 1 << i;
    if ((u_selectedMask & bit) != 0) {
      float margin = profileMargin(distanceM, i);
      minMargin = min(minMargin, margin);
      if (margin >= 0.0) {
        reachableMask |= bit;
      }
    }
  }

  bool losReachable = requiredAlt <= u_maxAltM;
  bool rfReachable = reachableMask == u_selectedMask;
  if (!losReachable || !rfReachable) {
    if (u_debugMode == 1) {
      out_color = vec4(0.95, 0.95, 0.95, 0.22);
    } else {
      out_color = vec4(0.0);
    }
    return;
  }

  float altT = clamp((requiredAlt - u_minAltM) / max(1.0, u_maxAltM - u_minAltM), 0.0, 1.0);
  vec3 color = altitudeRamp(altT);

  if (u_debugMode == 1) {
    color = vec3(0.1, 0.7, 1.0);
  } else if (u_debugMode == 2) {
    float m = clamp((minMargin + 12.0) / 36.0, 0.0, 1.0);
    color = mix(vec3(0.85, 0.1, 0.08), vec3(0.1, 0.75, 0.28), m);
  } else if (u_debugMode == 3) {
    color = vec3(0.6, 0.45, 0.9);
  }

  out_color = vec4(color, 0.42);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
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

export class CoverageRenderer {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uniforms: Record<string, WebGLUniformLocation | null>;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl);
    this.vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const pos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.uniforms = Object.fromEntries(
      [
        "u_operator",
        "u_radiusMercator",
        "u_radiusM",
        "u_minAltM",
        "u_maxAltM",
        "u_antennaHeightM",
        "u_debugMode",
        "u_selectedMask",
        "u_profileFreqMHz",
        "u_profileBudgetDb",
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]),
    );
  }

  render(request: AnalysisRequest, debugMode: DebugMode): void {
    const gl = this.gl;
    const operator = lngLatToMercator01(request.operator.lng, request.operator.lat);
    const radiusMercator = metersToMercatorUnits(request.radiusM, request.operator.lat);
    const mask = request.selectedProfileIds.reduce((value, id) => {
      const bit = id === "control" ? 1 : id === "telemetry" ? 2 : 4;
      return value | bit;
    }, 0);
    const profiles = ["control", "telemetry", "video"].map((id) =>
      request.profiles.find((profile) => profile.id === id),
    );
    const freqs = profiles.map((profile) => profile?.frequencyMHz ?? 1);
    const budgets = profiles.map((profile) => (profile ? profileBudget(profile) : -999));

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.uniforms.u_operator, operator.x, operator.y);
    gl.uniform1f(this.uniforms.u_radiusMercator, radiusMercator);
    gl.uniform1f(this.uniforms.u_radiusM, request.radiusM);
    gl.uniform1f(this.uniforms.u_minAltM, request.altitude.minM);
    gl.uniform1f(this.uniforms.u_maxAltM, request.altitude.maxM);
    gl.uniform1f(this.uniforms.u_antennaHeightM, request.operator.antennaHeightM);
    gl.uniform1i(this.uniforms.u_debugMode, this.debugModeId(debugMode));
    gl.uniform1i(this.uniforms.u_selectedMask, mask);
    gl.uniform4f(this.uniforms.u_profileFreqMHz, freqs[0], freqs[1], freqs[2], 1);
    gl.uniform4f(this.uniforms.u_profileBudgetDb, budgets[0], budgets[1], budgets[2], -999);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }

  private debugModeId(mode: DebugMode): number {
    if (mode === "los") return 1;
    if (mode === "margin") return 2;
    if (mode === "blocker" || mode === "shademap") return 3;
    return 0;
  }
}
