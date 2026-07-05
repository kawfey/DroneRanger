import {
  haversineDistanceM,
  lngLatToMercator01,
  mercator01ToLngLat,
} from "./coordinates";
import { buildingHeightM } from "./buildings";
import { combinedMaxFreeSpaceRangeM, linkMarginDb, maxFreeSpaceRangeM } from "./rf";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "../types";

const raySteps = 14;
const maxRfAnalysisRadiusM = 100000;

type TerrainSampler = {
  queryTerrainElevation(
    lngLat: { lng: number; lat: number },
    options?: { exaggerated: boolean },
  ): number | null | undefined;
  project?(lngLat: { lng: number; lat: number }): { x: number; y: number };
  getLayer?(id: string): unknown;
  queryRenderedFeatures?(
    point: { x: number; y: number },
    options?: { layers?: string[] },
  ): Array<{ properties?: Record<string, unknown> | null }>;
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

function selectedProfilesForMode(
  request: AnalysisRequest,
  debugMode: DebugMode,
): LinkProfile[] {
  if (debugMode === "los" || debugMode === "blocker" || debugMode === "shademap") {
    return [];
  }
  const modeProfile = profileForMode(request, debugMode);
  if (modeProfile) {
    return [modeProfile];
  }
  return request.profiles.filter((profile) => request.selectedProfileIds.includes(profile.id));
}

function analysisRadiusM(request: AnalysisRequest, debugMode: DebugMode): number {
  if (debugMode === "los" || debugMode === "blocker" || debugMode === "shademap") {
    return request.radiusM;
  }
  if (request.calculationRange.mode === "manual") {
    return Math.max(250, Math.min(maxRfAnalysisRadiusM, request.calculationRange.manualM));
  }
  const profiles = selectedProfilesForMode(request, debugMode);
  const rfRange =
    debugMode === "combined"
      ? combinedMaxFreeSpaceRangeM(profiles)
      : profiles[0]
        ? maxFreeSpaceRangeM(profiles[0])
        : request.radiusM;
  return Math.max(250, Math.min(maxRfAnalysisRadiusM, rfRange || request.radiusM));
}

export function inspectFlatEarthPixel(
  request: AnalysisRequest,
  target: { lng: number; lat: number },
  debugMode: DebugMode,
): CoveragePixel {
  const distanceM = haversineDistanceM(request.operator, target);
  const combinedProfiles = request.profiles.filter((profile) =>
    request.selectedProfileIds.includes(profile.id),
  );
  const modeProfile = profileForMode(request, debugMode);
  const activeProfiles = selectedProfilesForMode(request, debugMode);
  const combinedMarginDb = limitingMarginDb(distanceM, combinedProfiles);
  const modeMarginDb = modeProfile ? limitingMarginDb(distanceM, [modeProfile]) : null;
  const activeMarginDb = activeProfiles.length > 0 ? limitingMarginDb(distanceM, activeProfiles) : 0;
  const reachable = distanceM <= analysisRadiusM(request, debugMode) && activeMarginDb >= 0;
  const operatorAbsM = request.operator.antennaHeightM;
  const targetAbsM = request.altitude.minM;

  return {
    requiredAltitudeM: targetAbsM,
    requiredElevationChangeM: targetAbsM - operatorAbsM,
    operatorAltitudeAslM: operatorAbsM,
    reachable,
    combinedMarginDb,
    modeMarginDb,
    profileMask: combinedProfiles.reduce((mask, profile) => {
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
  let requiredTargetAbsM = targetTerrain + request.altitude.minM;

  for (let step = 1; step < raySteps; step++) {
    const t = step / raySteps;
    const sampleLngLat = mercator01ToLngLat({
      x: operatorMercator.x + (targetMercator.x - operatorMercator.x) * t,
      y: operatorMercator.y + (targetMercator.y - operatorMercator.y) * t,
    });
    const sampleTerrain = terrainElevation(map, sampleLngLat);
    const sampleObstacleAbsM = obstacleElevation(map, request, sampleLngLat, sampleTerrain);
    const sampleRequiredTargetAbsM = operatorAbsM + (sampleObstacleAbsM - operatorAbsM) / t;
    requiredTargetAbsM = Math.max(requiredTargetAbsM, sampleRequiredTargetAbsM);
  }

  const requiredAltitudeM = requiredTargetAbsM - targetTerrain;

  return {
    ...pixel,
    requiredAltitudeM,
    requiredElevationChangeM: requiredTargetAbsM - operatorAbsM,
    operatorAltitudeAslM: operatorAbsM,
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

function obstacleElevation(
  map: TerrainSampler,
  request: AnalysisRequest,
  lngLat: { lng: number; lat: number },
  terrainM: number,
): number {
  if (
    !request.includeBuildings ||
    !map.project ||
    !map.getLayer?.("los-building-reference") ||
    !map.queryRenderedFeatures
  ) {
    return terrainM;
  }

  try {
    const features = map.queryRenderedFeatures(map.project(lngLat), {
      layers: ["los-building-reference"],
    });
    const buildingM = features.reduce(
      (height, feature) => Math.max(height, buildingHeightM(feature)),
      0,
    );
    return terrainM + buildingM;
  } catch {
    return terrainM;
  }
}
