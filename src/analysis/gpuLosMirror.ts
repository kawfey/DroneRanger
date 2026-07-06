import type { AnalysisRequest } from "../types";

export function evaluateHeightFieldLos(
  heights: ArrayLike<number>,
  width: number,
  height: number,
  request: AnalysisRequest,
  targetUv: { u: number; v: number },
  stepCount = 24,
): { requiredAltitudeM: number; reachable: boolean } {
  const operatorTerrain = sampleHeight(heights, width, height, 0.5, 0.5);
  const targetTerrain = sampleHeight(heights, width, height, targetUv.u, targetUv.v);
  const operatorAbsM = operatorTerrain + request.operator.antennaHeightM;
  let requiredTargetAbsM = Math.max(
    operatorAbsM + request.altitude.minM,
    targetTerrain + request.altitude.minM,
  );

  for (let step = 1; step < stepCount; step++) {
    const t = step / stepCount;
    const u = 0.5 + (targetUv.u - 0.5) * t;
    const v = 0.5 + (targetUv.v - 0.5) * t;
    const obstacleM = sampleHeight(heights, width, height, u, v);
    requiredTargetAbsM = Math.max(requiredTargetAbsM, operatorAbsM + (obstacleM - operatorAbsM) / t);
  }

  const requiredAltitudeM = requiredTargetAbsM - operatorAbsM;
  return {
    requiredAltitudeM,
    reachable: requiredAltitudeM <= request.altitude.maxM,
  };
}

function sampleHeight(heights: ArrayLike<number>, width: number, height: number, u: number, v: number): number {
  const x = Math.max(0, Math.min(width - 1, Math.round(u * (width - 1))));
  const y = Math.max(0, Math.min(height - 1, Math.round(v * (height - 1))));
  return heights[y * width + x] ?? 0;
}
