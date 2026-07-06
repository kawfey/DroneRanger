import { shadeRequiredAltitude } from "./coverageShading";
import type { AnalysisRequest, CoverageGridData, CoverageOverlay } from "../types";

export function plotCoverageGridData(
  data: CoverageGridData,
  analysis: AnalysisRequest,
  canvas: HTMLCanvasElement,
): CoverageOverlay {
  canvas.width = data.gridSizePx;
  canvas.height = data.gridSizePx;
  const context = canvas.getContext("2d");
  if (context) {
    context.imageSmoothingEnabled = false;
    const imageData = context.createImageData(data.gridSizePx, data.gridSizePx);
    for (let index = 0; index < data.reachable.length; index++) {
      if (!data.reachable[index]) {
        continue;
      }
      const [r, g, b, a] = shadeRequiredAltitude(data.requiredAltitudeM[index] ?? 0, analysis);
      const offset = index * 4;
      imageData.data[offset] = r;
      imageData.data[offset + 1] = g;
      imageData.data[offset + 2] = b;
      imageData.data[offset + 3] = a;
    }
    context.putImageData(imageData, 0, 0);
  }

  return {
    canvas,
    coordinates: data.coordinates,
    gridSizePx: data.gridSizePx,
    engine: data.engine,
    renderedOperator: data.renderedOperator,
  };
}
