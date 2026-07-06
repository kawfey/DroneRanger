import { defaultAnalysis } from "./analysis/defaults";
import {
  createCoverageGridSpec,
  flatHeightField,
  gridCellMercator,
  isGridCellInCircle,
  solveHeightFieldGrid,
  type HeightField,
} from "./analysis/coverageGrid";
import { mercator01ToLngLat } from "./analysis/coordinates";
import { GpuCoverageLayer } from "./gpuCoverageLayer";
import type { AnalysisRequest, DebugMode } from "./types";

type ValidationResult = {
  name: string;
  passed: boolean;
  maxAltitudeErrorM: number;
  maxDistanceErrorM: number;
  classificationMismatches: number;
  renderedAlphaMismatches: number;
  alphaDiameterPx?: number;
  expectedDiameterPx?: number;
  alphaDiameterRatio?: number;
  cells: number;
};

declare global {
  interface Window {
    runGpuCoverageValidation?: () => Promise<ValidationResult[]>;
  }
}

function coordinatesForAnalysis(): [[number, number], [number, number], [number, number], [number, number]] {
  return [[0, 0], [1, 0], [1, 1], [0, 1]];
}

function makeRequest(patch: Partial<AnalysisRequest> = {}): AnalysisRequest {
  return {
    ...defaultAnalysis,
    ...patch,
    gridSizePx: patch.gridSizePx ?? 64,
    includeBuildings: false,
  };
}

function ridgeField(spec: ReturnType<typeof createCoverageGridSpec>, heightM: number): HeightField {
  const field = flatHeightField(spec, 0);
  for (let y = 0; y < spec.gridSizePx; y++) {
    for (let x = 0; x < spec.gridSizePx; x++) {
      const target = mercator01ToLngLat(gridCellMercator(spec, x, y));
      if (
        target.lng > spec.request.operator.lng + 0.004 &&
        target.lng < spec.request.operator.lng + 0.006
      ) {
        field.elevations[y * spec.gridSizePx + x] = heightM;
      }
    }
  }
  return field;
}

function highTargetField(spec: ReturnType<typeof createCoverageGridSpec>): HeightField {
  const field = flatHeightField(spec, 0);
  for (let y = 0; y < spec.gridSizePx; y++) {
    for (let x = Math.floor(spec.gridSizePx * 0.72); x < spec.gridSizePx; x++) {
      field.elevations[y * spec.gridSizePx + x] = 90;
    }
  }
  return field;
}

async function validateScenario(
  layer: GpuCoverageLayer,
  name: string,
  request: AnalysisRequest,
  debugMode: DebugMode,
  field: HeightField,
): Promise<ValidationResult> {
  const spec = createCoverageGridSpec(request, debugMode);
  const cpu = solveHeightFieldGrid(spec, field);
  layer.updateHeightFieldForValidation(request, debugMode, spec.bounds, field.elevations);
  const gpuImage = layer.render();
  const cpuImage = layer.renderCpuReference();
  const gpu = layer.readNumericCoverage();
  let maxAltitudeErrorM = 0;
  let maxDistanceErrorM = 0;
  let classificationMismatches = 0;
  let renderedAlphaMismatches = 0;
  let worst = { x: 0, y: 0, cpu: 0, gpu: 0 };

  for (let y = 0; y < spec.gridSizePx; y++) {
    for (let x = 0; x < spec.gridSizePx; x++) {
      const cpuIndex = y * spec.gridSizePx + x;
      const gpuIndex = (spec.gridSizePx - 1 - y) * spec.gridSizePx + x;
      const gpuRequiredAltitudeM = gpu[gpuIndex * 4];
      const gpuDistanceM = gpu[gpuIndex * 4 + 3];
      const gpuReachable = gpu[gpuIndex * 4 + 1] >= 0.5 && gpu[gpuIndex * 4 + 2] >= 0.5;
      const cpuPixel = cpu[cpuIndex];
      const error = Math.abs(gpuRequiredAltitudeM - cpuPixel.requiredAltitudeM);
      if (isGridCellInCircle(spec, x, y)) {
        const distanceError = Math.abs(gpuDistanceM - cpuPixel.debugValue);
        if (error > maxAltitudeErrorM) {
          maxAltitudeErrorM = error;
          worst = { x, y, cpu: cpuPixel.requiredAltitudeM, gpu: gpuRequiredAltitudeM };
        }
        maxDistanceErrorM = Math.max(maxDistanceErrorM, distanceError);
      }
      if (gpuReachable !== cpuPixel.reachable) {
        classificationMismatches++;
      }
    }
  }

  if (gpuImage && cpuImage) {
    const gpuAlpha = renderedAlpha(gpuImage.canvas);
    const cpuAlpha = renderedAlpha(cpuImage.canvas);
    for (let index = 0; index < cpuAlpha.length; index++) {
      if (((gpuAlpha[index] ?? 0) > 0) !== ((cpuAlpha[index] ?? 0) > 0)) {
        renderedAlphaMismatches++;
      }
    }
  } else {
    renderedAlphaMismatches = spec.gridSizePx * spec.gridSizePx;
  }

  return {
    name,
    passed:
      maxAltitudeErrorM <= 0.01 &&
      maxDistanceErrorM <= 4 &&
      classificationMismatches === 0 &&
      renderedAlphaMismatches === 0,
    maxAltitudeErrorM,
    maxDistanceErrorM,
    classificationMismatches,
    renderedAlphaMismatches,
    cells: cpu.length,
    ...worst,
  };
}

function renderedAlpha(canvas: HTMLCanvasElement): Uint8Array {
  let source = canvas;
  let context = source.getContext("2d", { willReadFrequently: true });
  if (!context) {
    source = document.createElement("canvas");
    source.width = canvas.width;
    source.height = canvas.height;
    context = source.getContext("2d", { willReadFrequently: true });
    context?.drawImage(canvas, 0, 0);
  }
  if (!context) {
    return new Uint8Array(canvas.width * canvas.height);
  }
  const data = context.getImageData(0, 0, source.width, source.height).data;
  const alpha = new Uint8Array(source.width * source.height);
  for (let index = 0; index < alpha.length; index++) {
    alpha[index] = data[index * 4 + 3] ?? 0;
  }
  return alpha;
}

function alphaBounds(alpha: Uint8Array, width: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = width;
  let minY = Math.ceil(alpha.length / width);
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < alpha.length; index++) {
    if (!alpha[index]) {
      continue;
    }
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

async function validateLosFootprintDiameter(
  layer: GpuCoverageLayer,
  request: AnalysisRequest,
): Promise<ValidationResult> {
  const spec = createCoverageGridSpec(request, "los");
  layer.updateHeightFieldForValidation(request, "los", spec.bounds, flatHeightField(spec, 0).elevations);
  const gpuImage = layer.render();
  const alpha = gpuImage ? renderedAlpha(gpuImage.canvas) : new Uint8Array(spec.gridSizePx * spec.gridSizePx);
  const bounds = alphaBounds(alpha, spec.gridSizePx);
  const alphaDiameterPx = bounds ? Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1) : 0;
  const expectedDiameterPx = spec.gridSizePx;
  const alphaDiameterRatio = alphaDiameterPx / expectedDiameterPx;

  return {
    name: "LOS footprint fills calculation radius",
    passed: alphaDiameterRatio >= 0.95,
    maxAltitudeErrorM: 0,
    maxDistanceErrorM: 0,
    classificationMismatches: 0,
    renderedAlphaMismatches: 0,
    alphaDiameterPx,
    expectedDiameterPx,
    alphaDiameterRatio,
    cells: spec.gridSizePx * spec.gridSizePx,
  };
}

window.runGpuCoverageValidation = async () => {
  const layer = GpuCoverageLayer.create({
    mapboxToken: "validation",
    texturePx: 64,
    coordinatesForAnalysis,
  });
  if (!layer) {
    throw new Error("WebGL2 float coverage is unavailable");
  }

  const flatRequest = makeRequest();
  const flatSpec = createCoverageGridSpec(flatRequest, "combined");
  const ridgeRequest = makeRequest({ altitude: { ...defaultAnalysis.altitude, maxM: 70 } });
  const ridgeSpec = createCoverageGridSpec(ridgeRequest, "los");
  const cutoffRequest = makeRequest({
    calculationRange: { mode: "manual", manualM: 700 },
  });
  const cutoffSpec = createCoverageGridSpec(cutoffRequest, "combined");
  const highTargetRequest = makeRequest({ altitude: { ...defaultAnalysis.altitude, maxM: 70 } });
  const highTargetSpec = createCoverageGridSpec(highTargetRequest, "los");
  const losFootprintRequest = makeRequest({
    radiusM: 4000,
    gridSizePx: 100,
    calculationRange: { mode: "manual", manualM: 4000 },
    altitude: { minM: 0, maxM: 120 },
  });

  try {
    return [
      await validateScenario(layer, "flat terrain", flatRequest, "combined", flatHeightField(flatSpec, 0)),
      await validateScenario(layer, "single ridge", ridgeRequest, "los", ridgeField(ridgeSpec, 80)),
      await validateScenario(layer, "high target terrain", highTargetRequest, "los", highTargetField(highTargetSpec)),
      await validateScenario(layer, "manual range cutoff", cutoffRequest, "combined", flatHeightField(cutoffSpec, 0)),
      await validateLosFootprintDiameter(layer, losFootprintRequest),
    ];
  } finally {
    layer.dispose();
  }
};
