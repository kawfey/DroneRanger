import { linkMarginDb } from "./rf";
import { haversineDistanceM } from "./coordinates";
import type { AnalysisRequest, CoveragePixel } from "../types";

export function inspectFlatEarthPixel(
  request: AnalysisRequest,
  target: { lng: number; lat: number },
): CoveragePixel {
  const distanceM = haversineDistanceM(request.operator, target);
  const selected = request.profiles.filter((profile) =>
    request.selectedProfileIds.includes(profile.id),
  );
  const margins = selected.map((profile) => linkMarginDb(distanceM, profile));
  const marginDb = margins.length > 0 ? Math.min(...margins) : 0;
  const reachable = distanceM <= request.radiusM && marginDb >= 0;

  return {
    requiredAltitudeM: request.altitude.minM,
    reachable,
    marginDb,
    profileMask: selected.reduce((mask, profile) => {
      const bit = profile.id === "control" ? 1 : profile.id === "telemetry" ? 2 : 4;
      return mask | bit;
    }, 0),
    debugValue: distanceM,
  };
}
