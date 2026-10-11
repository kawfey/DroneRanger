import { describe, expect, it } from "vitest";
import {
  coverageRayStepsForRadius,
  createCoverageGridSpec,
  evaluateHeightFieldLosRay,
  flatHeightField,
  gridRayDistanceM,
} from "./coverageGrid";
import { earthRadiusM } from "./coordinates";
import { defaultAnalysis } from "./defaults";

describe("shader-equivalent LOS mirror", () => {
  function makeSpec(request = defaultAnalysis) {
    return createCoverageGridSpec({ ...request, gridSizePx: 25 }, "los");
  }

  function evaluateEastCell(request = defaultAnalysis, elevationM = 0) {
    const spec = makeSpec(request);
    const field = flatHeightField(spec, elevationM);
    const targetMercator = {
      x: spec.bounds.west + ((24 + 0.5) / spec.gridSizePx) * (spec.bounds.east - spec.bounds.west),
      y: spec.operatorMercator.y,
    };
    return { result: evaluateHeightFieldLosRay(spec, field, targetMercator), field, spec, targetMercator };
  }

  it("keeps flat terrain at the minimum altitude", () => {
    const { result } = evaluateEastCell();

    expect(result.requiredAltitudeM).toBe(defaultAnalysis.altitude.minM);
  });

  it("raises required altitude behind a ridge", () => {
    const { result, field, spec, targetMercator } = evaluateEastCell();
    for (let y = 0; y < spec.gridSizePx; y++) {
      field.elevations[y * spec.gridSizePx + 18] = 30;
    }

    const blocked = evaluateHeightFieldLosRay(spec, field, targetMercator);

    expect(blocked.requiredAltitudeM).toBeGreaterThan(result.requiredAltitudeM);
  });

  it("raises required altitude behind a canopy obstacle in the obstruction channel", () => {
    const { result, field, spec, targetMercator } = evaluateEastCell({
      ...defaultAnalysis,
      includeVegetation: true,
    });
    const obstacleElevations = new Float32Array(field.elevations);
    for (let y = 0; y < spec.gridSizePx; y++) {
      obstacleElevations[y * spec.gridSizePx + 18] = 30;
    }
    field.obstacleElevations = obstacleElevations;

    const blocked = evaluateHeightFieldLosRay(spec, field, targetMercator);

    expect(blocked.requiredAltitudeM).toBeGreaterThan(result.requiredAltitudeM);
  });

  it("marks terrain that exceeds the configured altitude as unreachable", () => {
    const request = {
      ...defaultAnalysis,
      altitude: { ...defaultAnalysis.altitude, maxM: 100 },
    };
    const { result, field, spec, targetMercator } = evaluateEastCell(request);
    field.elevations[12 * spec.gridSizePx + 18] = 250;

    const blocked = evaluateHeightFieldLosRay(spec, field, targetMercator);

    expect(result.requiredAltitudeM).toBeLessThanOrEqual(request.altitude.maxM);
    expect(blocked.requiredAltitudeM).toBeGreaterThan(request.altitude.maxM);
  });

  it("counts high target terrain as part of the required altitude", () => {
    const { field, spec, targetMercator } = evaluateEastCell();
    field.elevations[12 * spec.gridSizePx + 24] = 180;

    const result = evaluateHeightFieldLosRay(spec, field, targetMercator);

    expect(result.requiredAltitudeM).toBeCloseTo(178.5, 6);
  });

  it("raises required altitude with earth curvature at long range", () => {
    const request = { ...defaultAnalysis, radiusM: 50000 };
    const { result, spec, targetMercator } = evaluateEastCell(request);
    const distanceM = gridRayDistanceM(spec, targetMercator);
    const twoKR = 2 * (4 / 3) * earthRadiusM;
    const expectedM = (distanceM - Math.sqrt(twoKR * request.operator.antennaHeightM)) ** 2 / twoKR;

    expect(distanceM).toBeCloseTo(48000, 6);
    expect(result.minDroneAltitudeAglM).toBeLessThanOrEqual(expectedM + 0.01);
    expect(result.minDroneAltitudeAglM).toBeGreaterThan(expectedM * 0.98);
    expect(result.earthBulgeAtLimitM).toBeGreaterThan(0);
  });

  it("keeps the flat profile at long range when curvature is off", () => {
    const { result } = evaluateEastCell({
      ...defaultAnalysis,
      radiusM: 50000,
      propagation: { effectiveEarthRadiusK: null },
    });

    expect(result.requiredAltitudeM).toBe(defaultAnalysis.altitude.minM);
    expect(result.earthBulgeAtLimitM).toBe(0);
  });

  it("densifies ray sampling with the analysis radius up to the shader cap", () => {
    expect(coverageRayStepsForRadius(2500)).toBe(48);
    expect(coverageRayStepsForRadius(10000)).toBe(100);
    expect(coverageRayStepsForRadius(100000)).toBe(128);
  });
});
