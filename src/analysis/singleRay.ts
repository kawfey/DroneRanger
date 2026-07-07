import {
  haversineDistanceM,
  lngLatToMercator01,
  mercator01ToLngLat,
} from "./coordinates";
import { buildingHeightM } from "./buildings";
import { combinedMaxFreeSpaceRangeM, linkMarginDb, maxFreeSpaceRangeM } from "./rf";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "../types";

const raySteps = 24;
const maxRfAnalysisRadiusM = 100000;

function altitudeAglM(requiredTargetAbsM: number, targetTerrainM: number): number {
  return Math.max(0, requiredTargetAbsM - targetTerrainM);
}

export type TerrainSampler = {
  queryTerrainElevation(
    lngLat: { lng: number; lat: number },
    options?: { exaggerated: boolean },
  ): number | null | undefined;
  queryBuildingHeightM?(lngLat: { lng: number; lat: number }): number;
  queryVegetationHeightM?(lngLat: { lng: number; lat: number }): number;
  project?(lngLat: { lng: number; lat: number }): { x: number; y: number };
  getLayer?(id: string): unknown;
  queryRenderedFeatures?(
    point: { x: number; y: number },
    options?: { layers?: string[] },
  ): Array<{ properties?: Record<string, unknown> | null }>;
};

type ObstacleSample = {
  elevationM: number;
  source: "terrain" | "building" | "vegetation";
};

export type LosRayResult = {
  requiredAltitudeM: number;
  requiredTargetAbsM: number;
  requiredElevationChangeM: number;
  operatorAltitudeAslM: number;
  limitingObstacle: ObstacleSample["source"] | null;
  targetTerrainM: number;
};

export function occlusionHeightM(
  map: TerrainSampler,
  request: AnalysisRequest,
  lngLat: { lng: number; lat: number },
): number {
  const terrainM = terrainElevation(map, lngLat);
  return obstacleElevation(map, request, lngLat, terrainM).elevationM;
}

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
  if (debugMode === "los" || debugMode === "blocker" || debugMode === "height-map") {
    return [];
  }
  const modeProfile = profileForMode(request, debugMode);
  if (modeProfile) {
    return [modeProfile];
  }
  return request.profiles.filter((profile) => request.selectedProfileIds.includes(profile.id));
}

export function analysisRadiusM(request: AnalysisRequest, debugMode: DebugMode): number {
  if (debugMode === "los" || debugMode === "blocker" || debugMode === "height-map") {
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
  const activeRadiusM = analysisRadiusM(request, debugMode);
  const criteria = baseViolationCriteria(request, debugMode, distanceM, activeRadiusM, activeMarginDb);
  const reachable = criteria.size === 0;
  const operatorAbsM = request.operator.antennaHeightM;
  const targetTerrainM = 0;
  const targetAbsM = minimumTargetAltitudeM(request, operatorAbsM, targetTerrainM);
  return {
    requiredAltitudeM: targetAbsM - operatorAbsM,
    requiredElevationChangeM: targetAbsM - operatorAbsM,
    minDroneAltitudeAglM: altitudeAglM(targetAbsM, targetTerrainM),
    operatorAltitudeAslM: operatorAbsM,
    violationCriteria: criteriaLabel(criteria),
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

export function evaluateFlatEarthLosRay(
  request: AnalysisRequest,
  target: { lng: number; lat: number },
): LosRayResult {
  const operatorAbsM = request.operator.antennaHeightM;
  const targetTerrainM = 0;
  const requiredTargetAbsM = minimumTargetAltitudeM(request, operatorAbsM, targetTerrainM);
  return {
    requiredAltitudeM: requiredTargetAbsM - operatorAbsM,
    requiredTargetAbsM,
    requiredElevationChangeM: requiredTargetAbsM - operatorAbsM,
    operatorAltitudeAslM: operatorAbsM,
    limitingObstacle: null,
    targetTerrainM,
  };
}

export function evaluateTerrainLosRay(
  map: TerrainSampler,
  request: AnalysisRequest,
  target: { lng: number; lat: number },
): LosRayResult {
  const operatorTerrain = terrainElevation(map, request.operator);
  const targetTerrain = terrainElevation(map, target);
  const operatorAbsM = operatorTerrain + request.operator.antennaHeightM;
  const operatorMercator = lngLatToMercator01(request.operator.lng, request.operator.lat);
  const targetMercator = lngLatToMercator01(target.lng, target.lat);
  let requiredTargetAbsM = minimumTargetAltitudeM(request, operatorAbsM, targetTerrain);
  let limitingObstacle: ObstacleSample["source"] | null = null;

  for (let step = 1; step < raySteps; step++) {
    const t = step / raySteps;
    const sampleLngLat = mercator01ToLngLat({
      x: operatorMercator.x + (targetMercator.x - operatorMercator.x) * t,
      y: operatorMercator.y + (targetMercator.y - operatorMercator.y) * t,
    });
    const sampleTerrain = terrainElevation(map, sampleLngLat);
    const sampleObstacle = obstacleElevation(map, request, sampleLngLat, sampleTerrain);
    const sampleRequiredTargetAbsM = operatorAbsM + (sampleObstacle.elevationM - operatorAbsM) / t;
    if (sampleRequiredTargetAbsM > requiredTargetAbsM) {
      requiredTargetAbsM = sampleRequiredTargetAbsM;
      limitingObstacle = sampleObstacle.source;
    }
  }

  return {
    requiredAltitudeM: requiredTargetAbsM - operatorAbsM,
    requiredTargetAbsM,
    requiredElevationChangeM: requiredTargetAbsM - operatorAbsM,
    operatorAltitudeAslM: operatorAbsM,
    limitingObstacle,
    targetTerrainM: targetTerrain,
  };
}

export function inspectTerrainPixel(
  map: TerrainSampler,
  request: AnalysisRequest,
  target: { lng: number; lat: number },
  debugMode: DebugMode,
): CoveragePixel {
  const pixel = inspectFlatEarthPixel(request, target, debugMode);
  const los = evaluateTerrainLosRay(map, request, target);
  const criteria = criteriaFromLabel(pixel.violationCriteria);
  if (altitudeCriterionValue(request, los) > request.altitude.maxM) {
    criteria.add(los.limitingObstacle === "building" ? "Building" : "Terrain");
  }

  const reachable = criteria.size === 0;
  return {
    ...pixel,
    requiredAltitudeM: los.requiredAltitudeM,
    requiredElevationChangeM: los.requiredElevationChangeM,
    minDroneAltitudeAglM: altitudeAglM(los.requiredTargetAbsM, los.targetTerrainM),
    operatorAltitudeAslM: los.operatorAltitudeAslM,
    violationCriteria: criteriaLabel(criteria),
    reachable,
  };
}

function minimumTargetAltitudeM(
  request: AnalysisRequest,
  operatorAbsM: number,
  targetTerrainM: number,
): number {
  if (request.altitudeCriterion === "agl") {
    return targetTerrainM + Math.max(0, request.altitude.minM);
  }
  return Math.max(operatorAbsM + request.altitude.minM, targetTerrainM + request.altitude.minM);
}

function altitudeCriterionValue(
  request: AnalysisRequest,
  los: { requiredElevationChangeM: number; requiredTargetAbsM: number; targetTerrainM: number },
): number {
  return request.altitudeCriterion === "agl"
    ? altitudeAglM(los.requiredTargetAbsM, los.targetTerrainM)
    : los.requiredElevationChangeM;
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
): ObstacleSample {
  const canopyM =
    request.includeVegetation && map.queryVegetationHeightM
      ? Math.max(0, map.queryVegetationHeightM(lngLat))
      : 0;
  const effectiveCanopyM = canopyM >= request.vegetation.minCanopyHeightM ? canopyM : 0;

  if (request.includeBuildings && map.queryBuildingHeightM) {
    const buildingM = map.queryBuildingHeightM(lngLat);
    const obstructionM = Math.max(buildingM, effectiveCanopyM);
    return {
      elevationM: terrainM + obstructionM,
      source: obstructionM === effectiveCanopyM && effectiveCanopyM > buildingM ? "vegetation" : buildingM > 0 ? "building" : "terrain",
    };
  }

  if (
    !request.includeBuildings ||
    !map.project ||
    !map.getLayer?.("los-building-reference") ||
    !map.queryRenderedFeatures
  ) {
    return {
      elevationM: terrainM + effectiveCanopyM,
      source: effectiveCanopyM > 0 ? "vegetation" : "terrain",
    };
  }

  try {
    const features = map.queryRenderedFeatures(map.project(lngLat), {
      layers: ["los-building-reference"],
    });
    const buildingM = features.reduce(
      (height, feature) => Math.max(height, buildingHeightM(feature)),
      0,
    );
    const obstructionM = Math.max(buildingM, effectiveCanopyM);
    return {
      elevationM: terrainM + obstructionM,
      source: obstructionM === effectiveCanopyM && effectiveCanopyM > buildingM ? "vegetation" : buildingM > 0 ? "building" : "terrain",
    };
  } catch {
    return {
      elevationM: terrainM + effectiveCanopyM,
      source: effectiveCanopyM > 0 ? "vegetation" : "terrain",
    };
  }
}

function baseViolationCriteria(
  request: AnalysisRequest,
  debugMode: DebugMode,
  distanceM: number,
  activeRadiusM: number,
  activeMarginDb: number,
): Set<string> {
  const criteria = new Set<string>();
  if (distanceM > activeRadiusM) {
    criteria.add(request.calculationRange.mode === "auto" && isRfMode(debugMode) ? "RF" : "Range");
  } else if (activeMarginDb < 0) {
    criteria.add("RF");
  }
  return criteria;
}

function isRfMode(debugMode: DebugMode): boolean {
  return debugMode !== "los" && debugMode !== "blocker" && debugMode !== "height-map";
}

function criteriaFromLabel(label: string): Set<string> {
  return new Set(label === "None" ? [] : label.split(", "));
}

function criteriaLabel(criteria: Set<string>): string {
  return criteria.size > 0 ? [...criteria].join(", ") : "None";
}
