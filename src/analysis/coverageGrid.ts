import { analysisMercatorBounds, mercatorToTextureUv, type MercatorBounds } from "./demTiles";
import { haversineDistanceM, mercator01ToLngLat, type WebMercator } from "./coordinates";
import { analysisRadiusM } from "./singleRay";
import { combinedMaxFreeSpaceRangeM, linkMarginDb, maxFreeSpaceRangeM } from "./rf";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile } from "../types";

export const coverageRaySteps = 24;
export const minCoverageGridPx = 25;
export const maxCoverageGridPx = 384;

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
};

export function createCoverageGridSpec(
  request: AnalysisRequest,
  debugMode: DebugMode,
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
    gridSizePx: clampGridSize(request.gridSizePx),
    operatorMercator,
    operatorUv: mercatorToTextureUv(operatorMercator, bounds),
  };
}

export function clampGridSize(gridSizePx: number): number {
  return Math.max(minCoverageGridPx, Math.min(maxCoverageGridPx, Math.round(gridSizePx)));
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

export function sampleHeightField(field: HeightField, point: WebMercator): number {
  const uv = mercatorToTextureUv(point, field.bounds);
  const x = Math.max(0, Math.min(field.width - 1, uv.u * field.width - 0.5));
  const y = Math.max(0, Math.min(field.height - 1, uv.v * field.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(field.width - 1, x0 + 1);
  const y1 = Math.min(field.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const h00 = field.elevations[y0 * field.width + x0] ?? 0;
  const h10 = field.elevations[y0 * field.width + x1] ?? h00;
  const h01 = field.elevations[y1 * field.width + x0] ?? h00;
  const h11 = field.elevations[y1 * field.width + x1] ?? h10;
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
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
  if (los.requiredAltitudeM > request.altitude.maxM) {
    criteria.add("Terrain");
  }

  return {
    requiredAltitudeM: los.requiredAltitudeM,
    requiredElevationChangeM: los.requiredElevationChangeM,
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
  };
}

export function evaluateHeightFieldLosRay(
  spec: CoverageGridSpec,
  field: HeightField,
  targetMercator: WebMercator,
): {
  requiredAltitudeM: number;
  requiredElevationChangeM: number;
  operatorAltitudeAslM: number;
} {
  const request = spec.request;
  const operatorTerrain = sampleHeightField(field, spec.operatorMercator);
  const targetTerrain = sampleHeightField(field, targetMercator);
  const operatorAbsM = operatorTerrain + request.operator.antennaHeightM;
  let requiredTargetAbsM = Math.max(
    operatorAbsM + request.altitude.minM,
    targetTerrain + request.altitude.minM,
  );

  for (let step = 1; step < coverageRaySteps; step++) {
    const t = step / coverageRaySteps;
    const sample = {
      x: spec.operatorMercator.x + (targetMercator.x - spec.operatorMercator.x) * t,
      y: spec.operatorMercator.y + (targetMercator.y - spec.operatorMercator.y) * t,
    };
    const obstacleM = sampleHeightField(field, sample);
    requiredTargetAbsM = Math.max(requiredTargetAbsM, operatorAbsM + (obstacleM - operatorAbsM) / t);
  }

  return {
    requiredAltitudeM: requiredTargetAbsM - operatorAbsM,
    requiredElevationChangeM: requiredTargetAbsM - operatorAbsM,
    operatorAltitudeAslM: operatorAbsM,
  };
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
  if (debugMode === "los" || debugMode === "blocker") {
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
    criteria.add(request.calculationRange.mode === "auto" && debugMode !== "los" && debugMode !== "blocker" ? "RF" : "Range");
  } else if (activeMarginDb < 0) {
    criteria.add("RF");
  }
  return criteria;
}
