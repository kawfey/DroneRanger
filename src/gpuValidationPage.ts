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
  classificationMismatches: number;
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
  layer.render();
  const gpu = layer.readNumericCoverage();
  let maxAltitudeErrorM = 0;
  let classificationMismatches = 0;
  let worst = { x: 0, y: 0, cpu: 0, gpu: 0 };

  for (let y = 0; y < spec.gridSizePx; y++) {
    for (let x = 0; x < spec.gridSizePx; x++) {
      const cpuIndex = y * spec.gridSizePx + x;
      const gpuIndex = (spec.gridSizePx - 1 - y) * spec.gridSizePx + x;
      const gpuRequiredAltitudeM = gpu[gpuIndex * 4];
      const gpuReachable = gpu[gpuIndex * 4 + 1] >= 0.5 && gpu[gpuIndex * 4 + 2] >= 0.5;
      const cpuPixel = cpu[cpuIndex];
      const error = Math.abs(gpuRequiredAltitudeM - cpuPixel.requiredAltitudeM);
      if (isGridCellInCircle(spec, x, y) && error > maxAltitudeErrorM) {
        maxAltitudeErrorM = error;
        worst = { x, y, cpu: cpuPixel.requiredAltitudeM, gpu: gpuRequiredAltitudeM };
      }
      if (gpuReachable !== cpuPixel.reachable) {
        classificationMismatches++;
      }
    }
  }

  return {
    name,
    passed: maxAltitudeErrorM <= 1 && classificationMismatches === 0,
    maxAltitudeErrorM,
    classificationMismatches,
    cells: cpu.length,
    ...worst,
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

  try {
    return [
      await validateScenario(layer, "flat terrain", flatRequest, "combined", flatHeightField(flatSpec, 0)),
      await validateScenario(layer, "single ridge", ridgeRequest, "los", ridgeField(ridgeSpec, 80)),
      await validateScenario(layer, "high target terrain", highTargetRequest, "los", highTargetField(highTargetSpec)),
      await validateScenario(layer, "manual range cutoff", cutoffRequest, "combined", flatHeightField(cutoffSpec, 0)),
    ];
  } finally {
    layer.dispose();
  }
};
