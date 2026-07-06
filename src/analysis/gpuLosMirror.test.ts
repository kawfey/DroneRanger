import { describe, expect, it } from "vitest";
import { createCoverageGridSpec, evaluateHeightFieldLosRay, flatHeightField } from "./coverageGrid";
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
});
