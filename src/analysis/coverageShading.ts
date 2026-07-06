import type { AnalysisRequest, CoveragePixel } from "../types";

export function shadeForPixel(pixel: CoveragePixel, analysis: AnalysisRequest): [number, number, number, number] {
  if (!pixel.reachable) {
    return [0, 0, 0, 0];
  }
  return shadeRequiredAltitude(pixel.requiredAltitudeM, analysis);
}

export function shadeRequiredAltitude(
  requiredAltitudeM: number,
  analysis: AnalysisRequest,
): [number, number, number, number] {
  const span = Math.max(0.001, analysis.altitude.maxM - analysis.altitude.minM);
  const altitudeStepM = Math.max(0.001, Math.abs(analysis.altitude.stepM));
  const steppedAltitudeM =
    analysis.altitude.minM +
    Math.ceil((requiredAltitudeM - analysis.altitude.minM) / altitudeStepM) * altitudeStepM;
  const t = Math.max(0, Math.min(1, (steppedAltitudeM - analysis.altitude.minM) / span));
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
