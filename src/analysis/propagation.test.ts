import { describe, expect, it } from "vitest";
import {
  curvatureInvM,
  earthBulgeAlongPathM,
  earthBulgeM,
  fresnelRadiusM,
  lowestFrequencyMHz,
  requiredTargetAbsForSample,
} from "./propagation";
import { defaultProfiles } from "./defaults";

describe("propagation geometry", () => {
  it("computes the standard-atmosphere bulge at the midpoint of a 100 km path", () => {
    const bulge = earthBulgeM(50000, 50000, curvatureInvM(4 / 3));

    expect(bulge).toBeCloseTo(147.2, 0);
  });

  it("computes the geometric bulge for k = 1", () => {
    const bulge = earthBulgeM(50000, 50000, curvatureInvM(1));

    expect(bulge).toBeCloseTo(196.2, 0);
  });

  it("disables curvature for null or non-positive k", () => {
    expect(curvatureInvM(null)).toBe(0);
    expect(curvatureInvM(0)).toBe(0);
    expect(curvatureInvM(-1)).toBe(0);
    expect(earthBulgeAlongPathM(0.5, 100000, curvatureInvM(null))).toBe(0);
  });

  it("matches the d1·d2 form when expressed along the path", () => {
    const inv = curvatureInvM(4 / 3);

    expect(earthBulgeAlongPathM(0.25, 20000, inv)).toBeCloseTo(earthBulgeM(5000, 15000, inv), 9);
    expect(earthBulgeAlongPathM(0, 20000, inv)).toBe(0);
    expect(earthBulgeAlongPathM(1, 20000, inv)).toBe(0);
  });

  it("computes the first Fresnel zone radius", () => {
    expect(fresnelRadiusM(2450, 2500, 2500)).toBeCloseTo(12.37, 1);
    expect(fresnelRadiusM(5800, 2500, 2500)).toBeCloseTo(8.04, 1);
    expect(fresnelRadiusM(2450, 0, 5000)).toBe(0);
  });

  it("reports the lowest active frequency", () => {
    expect(lowestFrequencyMHz(defaultProfiles)).toBe(2450);
    expect(lowestFrequencyMHz([])).toBeNull();
  });

  it("extends the operator-to-obstacle line to the target", () => {
    expect(requiredTargetAbsForSample(10, 30, 0.5)).toBe(50);
    expect(requiredTargetAbsForSample(10, 10, 0.25)).toBe(10);
  });
});
