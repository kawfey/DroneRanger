import type { AnalysisRequest, CoveragePixel, DebugMode } from "../types";

export function shadeForPixel(
  pixel: CoveragePixel,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
): [number, number, number, number] {
  if (debugMode === "los") {
    return shadeLosReachability(pixel.reachable);
  }
  if (!pixel.reachable) {
    return [0, 0, 0, 0];
  }
  return shadeRequiredAltitude(altitudeCriterionValue(pixel, analysis), analysis);
}

export function shadeLosReachability(reachable: boolean): [number, number, number, number] {
  return reachable ? [28, 132, 255, 178] : [255, 255, 255, 150];
}

export function shadeRequiredAltitude(
  altitudeM: number,
  analysis: AnalysisRequest,
): [number, number, number, number] {
  const minAltitudeM = minColorAltitudeM(analysis);
  const span = Math.max(0.001, analysis.altitude.maxM - minAltitudeM);
  const altitudeStepM = span / Math.max(1, Math.round(analysis.colorSteps));
  const steppedAltitudeM =
    minAltitudeM +
    Math.ceil((altitudeM - minAltitudeM) / altitudeStepM) * altitudeStepM;
  const t = Math.max(0, Math.min(1, (steppedAltitudeM - minAltitudeM) / span));
  const stops: Array<{ t: number; color: [number, number, number] }> = [
    { t: 0, color: [31, 184, 88] },
    { t: 0.5, color: [247, 220, 72] },
    { t: 0.75, color: [242, 143, 44] },
    { t: 1, color: [220, 54, 46] },
  ];
  const upper = stops.find((stop) => stop.t >= t) ?? stops[stops.length - 1];
  const lower = stops[Math.max(0, stops.indexOf(upper) - 1)];
  const localT = upper.t === lower.t ? 0 : (t - lower.t) / (upper.t - lower.t);
  const r = Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * localT);
  const g = Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * localT);
  const b = Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * localT);
  return [r, g, b, 178];
}

export function altitudeCriterionValue(pixel: CoveragePixel, analysis: AnalysisRequest): number {
  return analysis.altitudeCriterion === "agl" ? pixel.minDroneAltitudeAglM : pixel.requiredElevationChangeM;
}

function minColorAltitudeM(analysis: AnalysisRequest): number {
  return analysis.altitudeCriterion === "agl" ? Math.max(0, analysis.altitude.minM) : analysis.altitude.minM;
}
