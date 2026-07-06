import {
  analysisMercatorBounds,
  chooseDemZoom,
  coveringDemTiles,
  mapboxTerrainRgbElevationM,
  type DemTileId,
  type MercatorBounds,
} from "./analysis/demTiles";
import {
  clampGridSize,
  coverageRaySteps,
  createCoverageGridSpec,
  gridCellMercator,
  sampleObstacleHeightField,
  solveHeightFieldGrid,
  type HeightField,
} from "./analysis/coverageGrid";
import { BuildingHeightTileLoader } from "./analysis/buildingTiles";
import { plotCoverageGridData } from "./analysis/coveragePlot";
import { analysisRadiusM } from "./analysis/singleRay";
import { combinedMaxFreeSpaceRangeM, maxFreeSpaceRangeM } from "./analysis/rf";
import type {
  AnalysisRequest,
  CoverageCoordinates,
  CoverageGridData,
  CoverageOverlay,
  CoverageTimings,
  DebugMode,
  LinkProfile,
} from "./types";

export type GpuCoverageLayerOptions = {
  mapboxToken: string;
  texturePx: number;
  coordinatesForAnalysis: (operator: AnalysisRequest["operator"], radiusM: number) => CoverageCoordinates;
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
uniform float u_heightTexturePx;
uniform vec2 u_operatorUv;
uniform float u_antennaHeightM;
uniform float u_minAltitudeM;
uniform float u_maxAltitudeM;
uniform int u_altitudeCriterion;
uniform float u_radiusM;
uniform float u_maxReachM;
uniform int u_raySteps;

in vec2 v_uv;
out vec4 outData;

vec2 heightPairAt(vec2 uv) {
  vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
  vec2 pixel = clampedUv * u_heightTexturePx - 0.5;
  vec2 base = floor(pixel);
  vec2 fracPart = pixel - base;
  vec2 maxPixel = vec2(u_heightTexturePx - 1.0);
  vec2 p00 = clamp(base, vec2(0.0), maxPixel);
  vec2 p11 = clamp(base + vec2(1.0), vec2(0.0), maxPixel);
  vec2 uv00 = (p00 + 0.5) / u_heightTexturePx;
  vec2 uv10 = (vec2(p11.x, p00.y) + 0.5) / u_heightTexturePx;
  vec2 uv01 = (vec2(p00.x, p11.y) + 0.5) / u_heightTexturePx;
  vec2 uv11 = (p11 + 0.5) / u_heightTexturePx;
  vec2 h00 = texture(u_height, uv00).rg;
  vec2 h10 = texture(u_height, uv10).rg;
  vec2 h01 = texture(u_height, uv01).rg;
  vec2 h11 = texture(u_height, uv11).rg;
  return mix(mix(h00, h10, fracPart.x), mix(h01, h11, fracPart.x), fracPart.y);
}

float terrainAt(vec2 uv) {
  return heightPairAt(uv).r;
}

float obstacleAt(vec2 uv) {
  return heightPairAt(uv).g;
}

vec4 solveCoverage(vec2 terrainUv) {
  vec2 circle = terrainUv * 2.0 - 1.0;
  if (dot(circle, circle) > 1.0) {
    return vec4(0.0, 0.0, 0.0, 0.0);
  }

  float distanceM = length(circle) * u_radiusM;
  float rangePass = distanceM <= u_maxReachM ? 1.0 : 0.0;
  if (distanceM > u_maxReachM) {
    return vec4(u_maxAltitudeM + 1.0, 0.0, rangePass, distanceM);
  }

  float operatorAbsM = terrainAt(u_operatorUv) + u_antennaHeightM;
  float targetTerrainM = terrainAt(terrainUv);
  float minAltitudeM = u_altitudeCriterion == 1 ? max(0.0, u_minAltitudeM) : u_minAltitudeM;
  float requiredTargetAbsM = u_altitudeCriterion == 1
    ? targetTerrainM + minAltitudeM
    : max(operatorAbsM + minAltitudeM, targetTerrainM + minAltitudeM);

  for (int step = 1; step < 128; step++) {
    if (step >= u_raySteps) {
      break;
    }
    float t = float(step) / float(u_raySteps);
    vec2 sampleUv = mix(u_operatorUv, terrainUv, t);
    float obstacleM = obstacleAt(sampleUv);
    requiredTargetAbsM = max(requiredTargetAbsM, operatorAbsM + (obstacleM - operatorAbsM) / max(t, 0.001));
  }

  float requiredAltitudeM = requiredTargetAbsM - operatorAbsM;
  float requiredAltitudeAglM = max(0.0, requiredTargetAbsM - targetTerrainM);
  float criterionAltitudeM = u_altitudeCriterion == 1 ? requiredAltitudeAglM : requiredAltitudeM;
  float reachable = criterionAltitudeM <= u_maxAltitudeM ? 1.0 : 0.0;
  return vec4(requiredAltitudeM, requiredAltitudeAglM, reachable * rangePass, distanceM);
}

void main() {
  vec2 terrainUv = vec2(v_uv.x, 1.0 - v_uv.y);
  outData = solveCoverage(terrainUv);
}`;

const colorFragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_height;
uniform float u_heightTexturePx;
uniform vec2 u_operatorUv;
uniform float u_antennaHeightM;
uniform float u_minAltitudeM;
uniform float u_maxAltitudeM;
uniform float u_colorSteps;
uniform int u_altitudeCriterion;
uniform float u_radiusM;
uniform float u_maxReachM;
uniform int u_raySteps;
uniform int u_debugMode;

in vec2 v_uv;
out vec4 outColor;

vec2 heightPairAt(vec2 uv) {
  vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
  vec2 pixel = clampedUv * u_heightTexturePx - 0.5;
  vec2 base = floor(pixel);
  vec2 fracPart = pixel - base;
  vec2 maxPixel = vec2(u_heightTexturePx - 1.0);
  vec2 p00 = clamp(base, vec2(0.0), maxPixel);
  vec2 p11 = clamp(base + vec2(1.0), vec2(0.0), maxPixel);
  vec2 uv00 = (p00 + 0.5) / u_heightTexturePx;
  vec2 uv10 = (vec2(p11.x, p00.y) + 0.5) / u_heightTexturePx;
  vec2 uv01 = (vec2(p00.x, p11.y) + 0.5) / u_heightTexturePx;
  vec2 uv11 = (p11 + 0.5) / u_heightTexturePx;
  vec2 h00 = texture(u_height, uv00).rg;
  vec2 h10 = texture(u_height, uv10).rg;
  vec2 h01 = texture(u_height, uv01).rg;
  vec2 h11 = texture(u_height, uv11).rg;
  return mix(mix(h00, h10, fracPart.x), mix(h01, h11, fracPart.x), fracPart.y);
}

float terrainAt(vec2 uv) {
  return heightPairAt(uv).r;
}

float obstacleAt(vec2 uv) {
  return heightPairAt(uv).g;
}

vec4 solveCoverage(vec2 terrainUv) {
  vec2 circle = terrainUv * 2.0 - 1.0;
  if (dot(circle, circle) > 1.0) {
    return vec4(0.0, 0.0, 0.0, 0.0);
  }

  float distanceM = length(circle) * u_radiusM;
  float rangePass = distanceM <= u_maxReachM ? 1.0 : 0.0;
  if (distanceM > u_maxReachM) {
    return vec4(u_maxAltitudeM + 1.0, 0.0, rangePass, distanceM);
  }

  float operatorAbsM = terrainAt(u_operatorUv) + u_antennaHeightM;
  float targetTerrainM = terrainAt(terrainUv);
  float minAltitudeM = u_altitudeCriterion == 1 ? max(0.0, u_minAltitudeM) : u_minAltitudeM;
  float requiredTargetAbsM = u_altitudeCriterion == 1
    ? targetTerrainM + minAltitudeM
    : max(operatorAbsM + minAltitudeM, targetTerrainM + minAltitudeM);

  for (int step = 1; step < 128; step++) {
    if (step >= u_raySteps) {
      break;
    }
    float t = float(step) / float(u_raySteps);
    vec2 sampleUv = mix(u_operatorUv, terrainUv, t);
    float obstacleM = obstacleAt(sampleUv);
    requiredTargetAbsM = max(requiredTargetAbsM, operatorAbsM + (obstacleM - operatorAbsM) / max(t, 0.001));
  }

  float requiredAltitudeM = requiredTargetAbsM - operatorAbsM;
  float requiredAltitudeAglM = max(0.0, requiredTargetAbsM - targetTerrainM);
  float criterionAltitudeM = u_altitudeCriterion == 1 ? requiredAltitudeAglM : requiredAltitudeM;
  float reachable = criterionAltitudeM <= u_maxAltitudeM ? 1.0 : 0.0;
  return vec4(requiredAltitudeM, requiredAltitudeAglM, reachable * rangePass, distanceM);
}

vec3 altitudeColor(float requiredAltitudeM) {
  float minAltitudeM = u_altitudeCriterion == 1 ? max(0.0, u_minAltitudeM) : u_minAltitudeM;
  float span = max(0.001, u_maxAltitudeM - minAltitudeM);
  float altitudeStepM = span / max(1.0, floor(u_colorSteps + 0.5));
  float steppedAltitudeM = minAltitudeM + ceil((requiredAltitudeM - minAltitudeM) / altitudeStepM) * altitudeStepM;
  float t = clamp((steppedAltitudeM - minAltitudeM) / span, 0.0, 1.0);
  vec3 green = vec3(31.0, 184.0, 88.0) / 255.0;
  vec3 yellow = vec3(247.0, 220.0, 72.0) / 255.0;
  vec3 orange = vec3(242.0, 143.0, 44.0) / 255.0;
  vec3 red = vec3(220.0, 54.0, 46.0) / 255.0;
  if (t <= 0.5) {
    return mix(green, yellow, t / 0.5);
  }
  if (t <= 0.75) {
    return mix(yellow, orange, (t - 0.5) / 0.25);
  }
  return mix(orange, red, (t - 0.75) / 0.25);
}

void main() {
  vec2 terrainUv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 coverage = solveCoverage(terrainUv);
  float reachable = coverage.z;
  if (coverage.w <= 0.0 && coverage.x == 0.0 && coverage.y == 0.0 && coverage.z == 0.0) {
    outColor = vec4(0.0);
    return;
  }
  if (u_debugMode == 4) {
    outColor = reachable >= 0.5 ? vec4(28.0 / 255.0, 132.0 / 255.0, 1.0, 178.0 / 255.0) : vec4(1.0, 1.0, 1.0, 150.0 / 255.0);
    return;
  }
  if (reachable < 0.5) {
    outColor = vec4(0.0);
    return;
  }
  float altitudeM = u_altitudeCriterion == 1 ? coverage.y : coverage.x;
  outColor = vec4(altitudeColor(altitudeM), 178.0 / 255.0);
}`;

export class GpuCoverageLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly numericProgram: WebGLProgram;
  private readonly colorProgram: WebGLProgram;
  private readonly heightTexture: WebGLTexture;
  private readonly numericTexture: WebGLTexture;
  private readonly numericFramebuffer: WebGLFramebuffer;
  private readonly cpuCanvas: HTMLCanvasElement;
  private readonly gpuCanvas: HTMLCanvasElement;
  private readonly tileCache = new Map<string, Promise<DecodedTile>>();
  private readonly buildingTileLoader: BuildingHeightTileLoader;
  private analysis: AnalysisRequest | null = null;
  private debugMode: DebugMode = "combined";
  private bounds: MercatorBounds | null = null;
  private heightData: Float32Array | null = null;
  private obstacleData: Float32Array | null = null;
  private demSignature = "";
  private demZoom: number | null = null;
  private demTileCount = 0;
  private lastUpdateTimings: Partial<CoverageTimings> = {};

  static create(options: GpuCoverageLayerOptions): GpuCoverageLayer | null {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
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
    this.colorProgram = createProgram(gl, vertexShaderSource, colorFragmentShaderSource);
    const texture = gl.createTexture();
    const numericTexture = gl.createTexture();
    const numericFramebuffer = gl.createFramebuffer();
    if (!texture || !numericTexture || !numericFramebuffer) {
      throw new Error("Unable to allocate GPU height texture");
    }
    this.heightTexture = texture;
    this.numericTexture = numericTexture;
    this.numericFramebuffer = numericFramebuffer;
    this.cpuCanvas = document.createElement("canvas");
    this.gpuCanvas = document.createElement("canvas");
    this.buildingTileLoader = new BuildingHeightTileLoader(options.mapboxToken);
    this.initNumericTarget();
    this.initGeometry(this.numericProgram);
    this.initGeometry(this.colorProgram);
  }

  async updateAnalysis(analysis: AnalysisRequest, debugMode: DebugMode): Promise<void> {
    const startedAt = performance.now();
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
    this.demZoom = z;
    const signature = [
      z,
      analysis.includeBuildings ? "buildings" : "terrain",
      bounds.west.toFixed(8),
      bounds.north.toFixed(8),
      bounds.east.toFixed(8),
      bounds.south.toFixed(8),
      this.options.texturePx,
    ].join(":");

    if (signature === this.demSignature) {
      this.lastUpdateTimings = { updateAnalysisMs: performance.now() - startedAt };
      return;
    }

    this.demSignature = signature;
    const demBuildStartedAt = performance.now();
    this.bounds = bounds;
    this.heightData = await this.buildHeightTexture(bounds, z);
    let buildingBuildMs: number | undefined;
    if (analysis.includeBuildings) {
      const buildingBuildStartedAt = performance.now();
      this.obstacleData = await this.buildObstacleTexture(bounds, this.heightData);
      buildingBuildMs = performance.now() - buildingBuildStartedAt;
    } else {
      this.obstacleData = null;
    }
    const demBuildMs = performance.now() - demBuildStartedAt;
    const demUploadStartedAt = performance.now();
    this.uploadHeightTexture(this.heightData, this.obstacleData);
    const demUploadMs = performance.now() - demUploadStartedAt;
    this.lastUpdateTimings = {
      demBuildMs,
      buildingBuildMs,
      demUploadMs,
      updateAnalysisMs: performance.now() - startedAt,
    };
  }

  updateHeightFieldForValidation(
    analysis: AnalysisRequest,
    debugMode: DebugMode,
    bounds: MercatorBounds,
    elevations: Float32Array,
    obstacleElevations: Float32Array | null = null,
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
    this.obstacleData = obstacleElevations;
    this.demSignature = "";
    this.demZoom = null;
    this.demTileCount = 0;
    this.uploadHeightTexture(elevations, obstacleElevations);
  }

  render(waitForCompletion = false): CoverageOverlay | null {
    if (!this.analysis || !this.bounds || !this.heightData) {
      return null;
    }

    if (this.debugMode === "height-map") {
      return this.renderHeightMap();
    }

    const gl = this.gl;
    const startedAt = performance.now();
    const radiusM = analysisRadiusM(this.analysis, this.debugMode);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.bindCoverageUniforms(this.colorProgram, radiusM);
    setUniform1f(gl, this.colorProgram, "u_colorSteps", this.analysis.colorSteps);
    setUniform1i(gl, this.colorProgram, "u_altitudeCriterion", altitudeCriterionIndex(this.analysis.altitudeCriterion));
    setUniform1i(gl, this.colorProgram, "u_debugMode", debugModeIndex(this.debugMode));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (waitForCompletion) {
      gl.finish();
    } else {
      gl.flush();
    }
    const gpuDrawMs = performance.now() - startedAt;

    return {
      canvas: this.canvas,
      coordinates: this.options.coordinatesForAnalysis(this.analysis.operator, radiusM),
      gridSizePx: this.canvas.width,
      engine: "gpu",
      renderedOperator: this.analysis.operator,
      timings: {
        totalMs: gpuDrawMs,
        ...this.lastUpdateTimings,
        gpuDrawMs,
      },
    };
  }

  renderCpuReference(): CoverageOverlay | null {
    if (this.debugMode === "height-map") {
      return this.renderHeightMap("cpu-fallback");
    }
    const solveStartedAt = performance.now();
    const data = this.solveCpuReferenceData();
    const cpuSolveMs = performance.now() - solveStartedAt;
    if (!data || !this.analysis) {
      return null;
    }
    return plotCoverageGridData(data, this.analysis, this.cpuCanvas, this.debugMode, {
      ...this.lastUpdateTimings,
      cpuSolveMs,
    });
  }

  private renderHeightMap(engine: CoverageOverlay["engine"] = "gpu"): CoverageOverlay | null {
    if (!this.analysis || !this.bounds || !this.heightData) {
      return null;
    }
    const startedAt = performance.now();
    this.gpuCanvas.width = this.canvas.width;
    this.gpuCanvas.height = this.canvas.height;
    const context = this.gpuCanvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.imageSmoothingEnabled = false;
    const imageData = context.createImageData(this.canvas.width, this.canvas.height);
    const spec = createCoverageGridSpec(this.analysis, this.debugMode);
    const field: HeightField = {
      width: this.options.texturePx,
      height: this.options.texturePx,
      bounds: this.bounds,
      elevations: this.heightData,
      obstacleElevations: this.obstacleData ?? undefined,
    };
    let minHeightM = Infinity;
    let maxHeightM = -Infinity;
    for (let y = 0; y < this.canvas.height; y++) {
      for (let x = 0; x < this.canvas.width; x++) {
        const dx = ((x + 0.5) / this.canvas.width) * 2 - 1;
        const dy = ((y + 0.5) / this.canvas.height) * 2 - 1;
        if (dx * dx + dy * dy > 1) {
          continue;
        }
        const heightM = sampleObstacleHeightField(field, gridCellMercator(spec, x, y));
        minHeightM = Math.min(minHeightM, heightM);
        maxHeightM = Math.max(maxHeightM, heightM);
      }
    }
    for (let y = 0; y < this.canvas.height; y++) {
      for (let x = 0; x < this.canvas.width; x++) {
        const dx = ((x + 0.5) / this.canvas.width) * 2 - 1;
        const dy = ((y + 0.5) / this.canvas.height) * 2 - 1;
        if (dx * dx + dy * dy > 1) {
          continue;
        }
        const heightM = sampleObstacleHeightField(field, gridCellMercator(spec, x, y));
        const [r, g, b, a] = shadeHeightMap(heightM, minHeightM, maxHeightM);
        const offset = (y * this.canvas.width + x) * 4;
        imageData.data[offset] = r;
        imageData.data[offset + 1] = g;
        imageData.data[offset + 2] = b;
        imageData.data[offset + 3] = a;
      }
    }
    context.putImageData(imageData, 0, 0);
    const radiusM = analysisRadiusM(this.analysis, this.debugMode);
    const renderMs = performance.now() - startedAt;
    return {
      canvas: this.gpuCanvas,
      coordinates: this.options.coordinatesForAnalysis(this.analysis.operator, radiusM),
      gridSizePx: this.canvas.width,
      engine,
      renderedOperator: this.analysis.operator,
      timings: {
        totalMs: renderMs,
        ...this.lastUpdateTimings,
        renderMs,
      },
    };
  }

  solveCpuReferenceData(): CoverageGridData | null {
    if (!this.analysis || !this.bounds || !this.heightData) {
      return null;
    }

    const spec = createCoverageGridSpec(this.analysis, this.debugMode);
    const field: HeightField = {
      width: this.options.texturePx,
      height: this.options.texturePx,
      bounds: this.bounds,
      elevations: this.heightData,
      obstacleElevations: this.obstacleData ?? undefined,
    };
    const pixels = solveHeightFieldGrid(spec, field);
    const requiredAltitudeM = new Float32Array(pixels.length);
    const requiredAltitudeAglM = new Float32Array(pixels.length);
    const reachable = new Uint8Array(pixels.length);
    for (let index = 0; index < pixels.length; index++) {
      const pixel = pixels[index];
      requiredAltitudeM[index] = pixel?.requiredAltitudeM ?? 0;
      requiredAltitudeAglM[index] = pixel?.minDroneAltitudeAglM ?? 0;
      reachable[index] = pixel?.reachable ? 1 : 0;
    }

    const radiusM = analysisRadiusM(this.analysis, this.debugMode);
    return {
      coordinates: this.options.coordinatesForAnalysis(this.analysis.operator, radiusM),
      gridSizePx: spec.gridSizePx,
      engine: "cpu-fallback",
      renderedOperator: this.analysis.operator,
      requiredAltitudeM,
      requiredAltitudeAglM,
      reachable,
    };
  }

  dispose(): void {
    this.gl.deleteProgram(this.numericProgram);
    this.gl.deleteProgram(this.colorProgram);
    this.gl.deleteTexture(this.heightTexture);
    this.gl.deleteTexture(this.numericTexture);
    this.gl.deleteFramebuffer(this.numericFramebuffer);
  }

  readNumericCoverage(): Float32Array {
    const gl = this.gl;
    const startedAt = performance.now();
    const output = new Float32Array(this.canvas.width * this.canvas.height * 4);
    this.renderNumericCoverage();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.numericFramebuffer);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.FLOAT, output);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lastUpdateTimings = {
      ...this.lastUpdateTimings,
      gpuReadbackMs: performance.now() - startedAt,
    };
    return output;
  }

  readGpuCoverageData(): CoverageGridData | null {
    if (!this.analysis) {
      return null;
    }

    const width = this.canvas.width;
    const height = this.canvas.height;
    const numeric = this.readNumericCoverage();
    const requiredAltitudeM = new Float32Array(width * height);
    const requiredAltitudeAglM = new Float32Array(width * height);
    const reachableData = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const gpuY = height - 1 - y;
      for (let x = 0; x < width; x++) {
        const numericOffset = (gpuY * width + x) * 4;
        const reachable = (numeric[numericOffset + 2] ?? 0) >= 0.5;
        const outputIndex = y * width + x;
        requiredAltitudeM[outputIndex] = numeric[numericOffset] ?? 0;
        requiredAltitudeAglM[outputIndex] = numeric[numericOffset + 1] ?? 0;
        reachableData[outputIndex] = reachable ? 1 : 0;
      }
    }

    const radiusM = analysisRadiusM(this.analysis, this.debugMode);
    return {
      coordinates: this.options.coordinatesForAnalysis(this.analysis.operator, radiusM),
      gridSizePx: width,
      engine: "gpu",
      renderedOperator: this.analysis.operator,
      requiredAltitudeM,
      requiredAltitudeAglM,
      reachable: reachableData,
    };
  }

  private async buildHeightTexture(bounds: MercatorBounds, z: number): Promise<Float32Array> {
    const tileIds = coveringDemTiles(bounds, z);
    this.demTileCount = tileIds.length;
    const tiles = await Promise.all(tileIds.map((tile) => this.loadTile(tile)));
    const texturePx = this.options.texturePx;
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
        const localX = (mercatorX * scale - tileX) * tile.width - 0.5;
        const localY = (mercatorY * scale - tileY) * tile.height - 0.5;
        output[y * texturePx + x] = sampleDecodedTile(tile, localX, localY);
      }
    }

    return output;
  }

  private async buildObstacleTexture(bounds: MercatorBounds, terrainData: Float32Array): Promise<Float32Array> {
    const texturePx = this.options.texturePx;
    const buildingField = await this.buildingTileLoader.buildHeightField(bounds, texturePx, texturePx);
    const output = new Float32Array(terrainData.length);
    for (let index = 0; index < output.length; index++) {
      output[index] = (terrainData[index] ?? 0) + (buildingField.buildingHeightsM[index] ?? 0);
    }
    return output;
  }

  private uploadHeightTexture(terrainData: Float32Array, obstacleData: Float32Array | null = null): void {
    const gl = this.gl;
    const textureData = new Float32Array(terrainData.length * 2);
    for (let index = 0; index < terrainData.length; index++) {
      const terrainM = terrainData[index] ?? 0;
      textureData[index * 2] = terrainM;
      textureData[index * 2 + 1] = obstacleData?.[index] ?? terrainM;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32F,
      this.options.texturePx,
      this.options.texturePx,
      0,
      gl.RG,
      gl.FLOAT,
      textureData,
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

  private renderNumericCoverage(): void {
    if (!this.analysis) {
      return;
    }
    const gl = this.gl;
    const radiusM = analysisRadiusM(this.analysis, this.debugMode);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.numericFramebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.bindCoverageUniforms(this.numericProgram, radiusM);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.flush();
  }

  private bindCoverageUniforms(program: WebGLProgram, radiusM: number): void {
    const gl = this.gl;
    if (!this.analysis) {
      return;
    }
    const operatorUv = createCoverageGridSpec(this.analysis, this.debugMode).operatorUv;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    setUniform1i(gl, program, "u_height", 0);
    setUniform1f(gl, program, "u_heightTexturePx", this.options.texturePx);
    setUniform2f(gl, program, "u_operatorUv", operatorUv.u, operatorUv.v);
    setUniform1f(gl, program, "u_antennaHeightM", this.analysis.operator.antennaHeightM);
    setUniform1f(gl, program, "u_minAltitudeM", this.analysis.altitude.minM);
    setUniform1f(gl, program, "u_maxAltitudeM", this.analysis.altitude.maxM);
    setUniform1i(gl, program, "u_altitudeCriterion", altitudeCriterionIndex(this.analysis.altitudeCriterion));
    setUniform1f(gl, program, "u_radiusM", radiusM);
    setUniform1f(gl, program, "u_maxReachM", maxReachM(this.analysis, this.debugMode, radiusM));
    setUniform1i(gl, program, "u_raySteps", coverageRaySteps);
  }

  private initGeometry(program: WebGLProgram): void {
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
    const position = gl.getAttribLocation(program, "a_position");
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

function sampleDecodedTile(tile: DecodedTile, x: number, y: number): number {
  const clampedX = Math.max(0, Math.min(tile.width - 1, x));
  const clampedY = Math.max(0, Math.min(tile.height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(tile.width - 1, x0 + 1);
  const y1 = Math.min(tile.height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const h00 = tile.elevations[y0 * tile.width + x0] ?? 0;
  const h10 = tile.elevations[y0 * tile.width + x1] ?? h00;
  const h01 = tile.elevations[y1 * tile.width + x0] ?? h00;
  const h11 = tile.elevations[y1 * tile.width + x1] ?? h10;
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
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
  if (debugMode === "los" || debugMode === "blocker" || debugMode === "height-map") {
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

function debugModeIndex(debugMode: DebugMode): number {
  return debugMode === "los" ? 4 : 0;
}

function altitudeCriterionIndex(criterion: AnalysisRequest["altitudeCriterion"]): number {
  return criterion === "agl" ? 1 : 0;
}

function shadeHeightMap(heightM: number, minHeightM: number, maxHeightM: number): [number, number, number, number] {
  const span = Math.max(0.001, maxHeightM - minHeightM);
  const t = Math.max(0, Math.min(1, (heightM - minHeightM) / span));
  const stops: Array<{ t: number; color: [number, number, number] }> = [
    { t: 0, color: [34, 48, 92] },
    { t: 0.35, color: [31, 147, 139] },
    { t: 0.7, color: [246, 196, 83] },
    { t: 1, color: [238, 88, 73] },
  ];
  const upper = stops.find((stop) => stop.t >= t) ?? stops[stops.length - 1];
  const lower = stops[Math.max(0, stops.indexOf(upper) - 1)];
  const localT = upper.t === lower.t ? 0 : (t - lower.t) / (upper.t - lower.t);
  return [
    Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * localT),
    Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * localT),
    Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * localT),
    210,
  ];
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
