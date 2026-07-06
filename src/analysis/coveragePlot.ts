import { shadeLosReachability, shadeRequiredAltitude } from "./coverageShading";
import type { AnalysisRequest, CoverageGridData, CoverageOverlay, CoverageTimings, DebugMode } from "../types";

export function plotCoverageGridData(
  data: CoverageGridData,
  analysis: AnalysisRequest,
  canvas: HTMLCanvasElement,
  debugMode: DebugMode,
  timings: Partial<CoverageTimings> = {},
): CoverageOverlay {
  const startedAt = performance.now();
  canvas.width = data.gridSizePx;
  canvas.height = data.gridSizePx;
  const context = canvas.getContext("2d");
  if (context) {
    context.imageSmoothingEnabled = false;
    const imageData = context.createImageData(data.gridSizePx, data.gridSizePx);
    for (let index = 0; index < data.reachable.length; index++) {
      const x = index % data.gridSizePx;
      const y = Math.floor(index / data.gridSizePx);
      const dx = ((x + 0.5) / data.gridSizePx) * 2 - 1;
      const dy = ((y + 0.5) / data.gridSizePx) * 2 - 1;
      if (dx * dx + dy * dy > 1) {
        continue;
      }
      const reachable = Boolean(data.reachable[index]);
      if (!reachable && debugMode !== "los") {
        continue;
      }
      const altitudeM =
        analysis.altitudeCriterion === "agl"
          ? data.requiredAltitudeAglM[index] ?? 0
          : data.requiredAltitudeM[index] ?? 0;
      const [r, g, b, a] =
        debugMode === "los"
          ? shadeLosReachability(reachable)
          : shadeRequiredAltitude(altitudeM, analysis);
      const offset = index * 4;
      imageData.data[offset] = r;
      imageData.data[offset + 1] = g;
      imageData.data[offset + 2] = b;
      imageData.data[offset + 3] = a;
    }
    context.putImageData(imageData, 0, 0);
  }
  const cpuShadeMs = performance.now() - startedAt;

  return {
    canvas,
    coordinates: data.coordinates,
    gridSizePx: data.gridSizePx,
    engine: data.engine,
    renderedOperator: data.renderedOperator,
    timings: {
      totalMs: (timings.cpuSolveMs ?? 0) + cpuShadeMs,
      ...timings,
      cpuShadeMs,
    },
  };
}
