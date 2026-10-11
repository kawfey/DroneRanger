import { earthRadiusM } from "./coordinates";
import type { LinkProfile } from "../types";

const speedOfLightMPerS = 299792458;

/** Fraction of the first Fresnel zone that planners treat as "clear" (reported, not enforced). */
export const fresnelClearanceFraction = 0.6;

/**
 * 1 / (2·k·R) in 1/m. Multiplying by d1·d2 gives the earth bulge; 0 means a flat vertical profile.
 * The shader receives this value directly so the off-switch stays a plain float.
 */
export function curvatureInvM(effectiveEarthRadiusK: number | null): number {
  if (effectiveEarthRadiusK === null || !(effectiveEarthRadiusK > 0)) {
    return 0;
  }
  return 1 / (2 * effectiveEarthRadiusK * earthRadiusM);
}

export function earthBulgeM(d1M: number, d2M: number, curvatureInv: number): number {
  return d1M * d2M * curvatureInv;
}

/** Bulge at fraction t of a path of ground length D, written in the same operation order as the GLSL solver. */
export function earthBulgeAlongPathM(t: number, distanceM: number, curvatureInv: number): number {
  return t * (1 - t) * distanceM * distanceM * curvatureInv;
}

export function wavelengthM(frequencyMHz: number): number {
  return speedOfLightMPerS / (frequencyMHz * 1e6);
}

export function fresnelRadiusM(frequencyMHz: number, d1M: number, d2M: number): number {
  const distanceM = d1M + d2M;
  if (frequencyMHz <= 0 || d1M <= 0 || d2M <= 0) {
    return 0;
  }
  return Math.sqrt((wavelengthM(frequencyMHz) * d1M * d2M) / distanceM);
}

/** Lowest frequency gives the widest Fresnel zone, so it is the one worth reporting for a combined link. */
export function lowestFrequencyMHz(profiles: LinkProfile[]): number | null {
  if (profiles.length === 0) {
    return null;
  }
  return Math.min(...profiles.map((profile) => profile.frequencyMHz));
}

/** Target altitude so that the straight operator→target line passes through an obstacle sample at fraction t. */
export function requiredTargetAbsForSample(operatorAbsM: number, obstacleM: number, t: number): number {
  return operatorAbsM + (obstacleM - operatorAbsM) / t;
}
