import { linkMarginDb } from "./rf";
import { haversineDistanceM } from "./coordinates";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "../types";

function limitingMarginDb(distanceM: number, profiles: LinkProfile[]): number {
  const margins = profiles.map((profile) => linkMarginDb(distanceM, profile));
  return margins.length > 0 ? Math.min(...margins) : 0;
}

function profileForMode(request: AnalysisRequest, debugMode: DebugMode): LinkProfile | null {
  if (debugMode !== "control" && debugMode !== "telemetry" && debugMode !== "video") {
    return null;
  }
  return request.profiles.find((profile) => profile.id === debugMode) ?? null;
}

export function inspectFlatEarthPixel(
  request: AnalysisRequest,
  target: { lng: number; lat: number },
  debugMode: DebugMode,
): CoveragePixel {
  const distanceM = haversineDistanceM(request.operator, target);
  const selected = request.profiles.filter((profile) =>
    request.selectedProfileIds.includes(profile.id),
  );
  const modeProfile = profileForMode(request, debugMode);
  const combinedMarginDb = limitingMarginDb(distanceM, selected);
  const modeMarginDb = modeProfile ? limitingMarginDb(distanceM, [modeProfile]) : null;
  const reachable = distanceM <= request.radiusM && combinedMarginDb >= 0;

  return {
    requiredAltitudeM: request.altitude.minM,
    reachable,
    combinedMarginDb,
    modeMarginDb,
    profileMask: selected.reduce((mask, profile) => {
      const bit = profile.id === "control" ? 1 : profile.id === "telemetry" ? 2 : 4;
      return mask | bit;
    }, 0),
    debugValue: distanceM,
  };
}
