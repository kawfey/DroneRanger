import { analysisMercatorBounds, mercatorToTextureUv, type MercatorBounds } from "./demTiles";
import { haversineDistanceM, mercator01ToLngLat, type WebMercator } from "./coordinates";
import { analysisRadiusM, coverageRayStepsForRadius, maxCoverageRaySteps } from "./singleRay";
import { combinedMaxFreeSpaceRangeM, linkMarginDb, maxFreeSpaceRangeM } from "./rf";
import { curvatureInvM, earthBulgeAlongPathM, requiredTargetAbsForSample } from "./propagation";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "../types";

export { coverageRayStepsForRadius, maxCoverageRaySteps };
export const minCoverageGridPx = 25;
export const maxCpuCoverageGridPx = 384;
export const maxGpuCoverageGridPx = 1024;
export const maxCoverageGridPx = maxCpuCoverageGridPx;

function altitudeAglM(requiredTargetAbsM: number, targetTerrainM: number): number {
  return Math.max(0, requiredTargetAbsM - targetTerrainM);
}

export type CoverageGridSpec = {
  request: AnalysisRequest;
  debugMode: DebugMode;
  radiusM: number;
  bounds: MercatorBounds;
  gridSizePx: number;
  operatorMercator: WebMercator;
  operatorUv: { u: number; v: number };
};

export type HeightField = {
  width: number;
  height: number;
  bounds: MercatorBounds;
  elevations: Float32Array;
  obstacleElevations?: Float32Array;
};

export function createCoverageGridSpec(
  request: AnalysisRequest,
  debugMode: DebugMode,
  maxGridSizePx = maxCoverageGridPx,
): CoverageGridSpec {
  const radiusM = analysisRadiusM(request, debugMode);
  const bounds = analysisMercatorBounds(request, radiusM);
  const operatorMercator = {
    x: (bounds.west + bounds.east) / 2,
    y: (bounds.north + bounds.south) / 2,
  };
  return {
    request,
    debugMode,
    radiusM,
    bounds,
    gridSizePx: clampGridSize(request.gridSizePx, maxGridSizePx),
    operatorMercator,
    operatorUv: mercatorToTextureUv(operatorMercator, bounds),
  };
}

export function clampGridSize(gridSizePx: number, maxGridSizePx = maxCoverageGridPx): number {
  return Math.max(minCoverageGridPx, Math.min(maxGridSizePx, Math.round(gridSizePx)));
}

export function gridCellMercator(spec: CoverageGridSpec, x: number, y: number): WebMercator {
  const nx = (x + 0.5) / spec.gridSizePx;
  const ny = (y + 0.5) / spec.gridSizePx;
  return {
    x: spec.bounds.west + nx * (spec.bounds.east - spec.bounds.west),
    y: spec.bounds.north + ny * (spec.bounds.south - spec.bounds.north),
  };
}

export function isGridCellInCircle(spec: CoverageGridSpec, x: number, y: number): boolean {
  const nx = (x + 0.5) / spec.gridSizePx;
  const ny = (y + 0.5) / spec.gridSizePx;
  const dx = nx * 2 - 1;
  const dy = ny * 2 - 1;
  return dx * dx + dy * dy <= 1;
}

function sampleFieldData(field: HeightField, point: WebMercator, data: Float32Array): number {
  const uv = mercatorToTextureUv(point, field.bounds);
  const x = Math.max(0, Math.min(field.width - 1, uv.u * field.width - 0.5));
  const y = Math.max(0, Math.min(field.height - 1, uv.v * field.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(field.width - 1, x0 + 1);
  const y1 = Math.min(field.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const h00 = data[y0 * field.width + x0] ?? 0;
  const h10 = data[y0 * field.width + x1] ?? h00;
  const h01 = data[y1 * field.width + x0] ?? h00;
  const h11 = data[y1 * field.width + x1] ?? h10;
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}

export function sampleHeightField(field: HeightField, point: WebMercator): number {
  return sampleFieldData(field, point, field.elevations);
}

export function sampleObstacleHeightField(field: HeightField, point: WebMercator): number {
  return sampleFieldData(field, point, field.obstacleElevations ?? field.elevations);
}

export function solveHeightFieldPixel(
  spec: CoverageGridSpec,
  field: HeightField,
  x: number,
  y: number,
): CoveragePixel {
  const request = spec.request;
  const targetMercator = gridCellMercator(spec, x, y);
  const targetLngLat = mercator01ToLngLat(targetMercator);
  const distanceM = haversineDistanceM(request.operator, targetLngLat);
  const combinedProfiles = request.profiles.filter((profile) =>
    request.selectedProfileIds.includes(profile.id),
  );
  const modeProfile = profileForMode(request, spec.debugMode);
  const activeProfiles = selectedProfilesForMode(request, spec.debugMode);
  const combinedMarginDb = limitingMarginDb(distanceM, combinedProfiles);
  const modeMarginDb = modeProfile ? limitingMarginDb(distanceM, [modeProfile]) : null;
  const activeMarginDb = activeProfiles.length > 0 ? limitingMarginDb(distanceM, activeProfiles) : 0;
  const criteria = baseViolationCriteria(request, spec.debugMode, distanceM, spec.radiusM, activeMarginDb);
  const los = evaluateHeightFieldLosRay(spec, field, targetMercator);

  if (!isGridCellInCircle(spec, x, y)) {
    criteria.add("Range");
  }
  if (altitudeCriterionValue(request, los) > request.altitude.maxM) {
    criteria.add("Terrain");
  }

  return {
    requiredAltitudeM: los.requiredAltitudeM,
    requiredElevationChangeM: los.requiredElevationChangeM,
    minDroneAltitudeAglM: los.minDroneAltitudeAglM,
    operatorAltitudeAslM: los.operatorAltitudeAslM,
    violationCriteria: criteria.size > 0 ? [...criteria].join(", ") : "None",
    reachable: criteria.size === 0,
    combinedMarginDb,
    modeMarginDb,
    profileMask: combinedProfiles.reduce((mask, profile) => {
      const bit = profile.id === "control" ? 1 : profile.id === "telemetry" ? 2 : 4;
      return mask | bit;
    }, 0),
    debugValue: distanceM,
    earthBulgeAtLimitM: los.earthBulgeAtLimitM,
    fresnelRadiusAtLimitM: null,
    fresnelClearElevationChangeM: null,
    fresnelClearAglM: null,
  };
}

/** Ground distance the way the shader measures it: planar in the analysis square, scaled by the radius. */
export function gridRayDistanceM(spec: CoverageGridSpec, targetMercator: WebMercator): number {
  const uv = mercatorToTextureUv(targetMercator, spec.bounds);
  const dx = uv.u * 2 - 1;
  const dy = uv.v * 2 - 1;
  return Math.sqrt(dx * dx + dy * dy) * spec.radiusM;
}

export function evaluateHeightFieldLosRay(
  spec: CoverageGridSpec,
  field: HeightField,
  targetMercator: WebMercator,
): {
  requiredAltitudeM: number;
  requiredElevationChangeM: number;
  minDroneAltitudeAglM: number;
  operatorAltitudeAslM: number;
  earthBulgeAtLimitM: number;
} {
  const request = spec.request;
  const raySteps = coverageRayStepsForRadius(spec.radiusM);
  const operatorTerrain = sampleHeightField(field, spec.operatorMercator);
  const targetTerrain = sampleHeightField(field, targetMercator);
  const operatorAbsM = operatorTerrain + request.operator.antennaHeightM;
  const distanceM = gridRayDistanceM(spec, targetMercator);
  const curvatureInv = curvatureInvM(request.propagation.effectiveEarthRadiusK);
  let requiredTargetAbsM = minimumTargetAltitudeM(request, operatorAbsM, targetTerrain);
  let earthBulgeAtLimitM = 0;

  for (let step = 1; step < raySteps; step++) {
    const t = step / raySteps;
    const sample = {
      x: spec.operatorMercator.x + (targetMercator.x - spec.operatorMercator.x) * t,
      y: spec.operatorMercator.y + (targetMercator.y - spec.operatorMercator.y) * t,
    };
    const bulgeM = earthBulgeAlongPathM(t, distanceM, curvatureInv);
    const obstacleM = sampleObstacleHeightField(field, sample) + bulgeM;
    const sampleRequiredTargetAbsM = requiredTargetAbsForSample(operatorAbsM, obstacleM, t);
    if (sampleRequiredTargetAbsM > requiredTargetAbsM) {
      requiredTargetAbsM = sampleRequiredTargetAbsM;
      earthBulgeAtLimitM = bulgeM;
    }
  }

  return {
    requiredAltitudeM: requiredTargetAbsM - operatorAbsM,
    requiredElevationChangeM: requiredTargetAbsM - operatorAbsM,
    minDroneAltitudeAglM: altitudeAglM(requiredTargetAbsM, targetTerrain),
    operatorAltitudeAslM: operatorAbsM,
    earthBulgeAtLimitM,
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
  los: { requiredElevationChangeM: number; minDroneAltitudeAglM: number },
): number {
  return request.altitudeCriterion === "agl" ? los.minDroneAltitudeAglM : los.requiredElevationChangeM;
}

export function solveHeightFieldGrid(spec: CoverageGridSpec, field: HeightField): CoveragePixel[] {
  const pixels: CoveragePixel[] = [];
  for (let y = 0; y < spec.gridSizePx; y++) {
    for (let x = 0; x < spec.gridSizePx; x++) {
      pixels.push(solveHeightFieldPixel(spec, field, x, y));
    }
  }
  return pixels;
}

export function flatHeightField(spec: CoverageGridSpec, elevationM = 0): HeightField {
  return {
    width: spec.gridSizePx,
    height: spec.gridSizePx,
    bounds: spec.bounds,
    elevations: new Float32Array(spec.gridSizePx * spec.gridSizePx).fill(elevationM),
  };
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

function selectedProfilesForMode(request: AnalysisRequest, debugMode: DebugMode): LinkProfile[] {
  if (debugMode === "los" || debugMode === "blocker" || debugMode === "height-map") {
    return [];
  }
  const modeProfile = profileForMode(request, debugMode);
  if (modeProfile) {
    return [modeProfile];
  }
  return request.profiles.filter((profile) => request.selectedProfileIds.includes(profile.id));
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
    criteria.add(
      request.calculationRange.mode === "auto" &&
        debugMode !== "los" &&
        debugMode !== "blocker" &&
        debugMode !== "height-map"
        ? "RF"
        : "Range",
    );
  } else if (activeMarginDb < 0) {
    criteria.add("RF");
  }
  return criteria;
}
