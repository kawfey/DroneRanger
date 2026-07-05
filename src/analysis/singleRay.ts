import { linkMarginDb } from "./rf";
import {
  haversineDistanceM,
  lngLatToMercator01,
  mercator01ToLngLat,
} from "./coordinates";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "../types";

const raySteps = 14;

type TerrainSampler = {
  queryTerrainElevation(
    lngLat: { lng: number; lat: number },
    options?: { exaggerated: boolean },
  ): number | null | undefined;
};

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

export function inspectTerrainPixel(
  map: TerrainSampler,
  request: AnalysisRequest,
  target: { lng: number; lat: number },
  debugMode: DebugMode,
): CoveragePixel {
  const pixel = inspectFlatEarthPixel(request, target, debugMode);
  const operatorTerrain = terrainElevation(map, request.operator);
  const targetTerrain = terrainElevation(map, target);
  const operatorAbsM = operatorTerrain + request.operator.antennaHeightM;
  const operatorMercator = lngLatToMercator01(request.operator.lng, request.operator.lat);
  const targetMercator = lngLatToMercator01(target.lng, target.lat);
  let requiredAltitudeM = request.altitude.minM;

  for (let step = 1; step < raySteps; step++) {
    const t = step / raySteps;
    const sampleLngLat = mercator01ToLngLat({
      x: operatorMercator.x + (targetMercator.x - operatorMercator.x) * t,
      y: operatorMercator.y + (targetMercator.y - operatorMercator.y) * t,
    });
    const sampleTerrain = terrainElevation(map, sampleLngLat);
    const requiredTargetAbsM = operatorAbsM + (sampleTerrain - operatorAbsM) / t;
    requiredAltitudeM = Math.max(requiredAltitudeM, requiredTargetAbsM - targetTerrain);
  }

  return {
    ...pixel,
    requiredAltitudeM,
    reachable: pixel.reachable && requiredAltitudeM <= request.altitude.maxM,
  };
}

function terrainElevation(
  map: TerrainSampler,
  lngLat: { lng: number; lat: number },
): number {
  const elevation = map.queryTerrainElevation(lngLat, { exaggerated: false });
  return typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
}
