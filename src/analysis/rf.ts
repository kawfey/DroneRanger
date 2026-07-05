import type { LinkProfile } from "../types";

export function fsplDb(distanceM: number, frequencyMHz: number): number {
  if (distanceM <= 0 || frequencyMHz <= 0) {
    return 0;
  }
  const distanceKm = distanceM / 1000;
  return 32.44 + 20 * Math.log10(distanceKm) + 20 * Math.log10(frequencyMHz);
}

export function receivedPowerDbm(distanceM: number, profile: LinkProfile): number {
  return (
    profile.txPowerDbm +
    profile.txGainDbi -
    profile.txLossDb +
    profile.rxGainDbi -
    profile.rxLossDb -
    fsplDb(distanceM, profile.frequencyMHz)
  );
}

export function linkMarginDb(distanceM: number, profile: LinkProfile): number {
  return receivedPowerDbm(distanceM, profile) - profile.rxSensitivityDbm - profile.requiredMarginDb;
}

export function maxFreeSpaceRangeM(profile: LinkProfile): number {
  const allowedLossDb =
    profile.txPowerDbm +
    profile.txGainDbi -
    profile.txLossDb +
    profile.rxGainDbi -
    profile.rxLossDb -
    profile.rxSensitivityDbm -
    profile.requiredMarginDb;
  const logDistanceKm = (allowedLossDb - 32.44 - 20 * Math.log10(profile.frequencyMHz)) / 20;
  return Math.max(0, 1000 * 10 ** logDistanceKm);
}

export function combinedMaxFreeSpaceRangeM(profiles: LinkProfile[]): number {
  if (profiles.length === 0) {
    return 0;
  }
  return Math.min(...profiles.map(maxFreeSpaceRangeM));
}
