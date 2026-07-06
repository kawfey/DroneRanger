import { describe, expect, it } from "vitest";
import { defaultAnalysis } from "./defaults";
import { evaluateHeightFieldLos } from "./gpuLosMirror";

describe("shader-equivalent LOS mirror", () => {
  it("keeps flat terrain at the minimum altitude", () => {
    const result = evaluateHeightFieldLos(new Float32Array(25), 5, 5, defaultAnalysis, { u: 1, v: 0.5 });

    expect(result.requiredAltitudeM).toBe(defaultAnalysis.altitude.minM);
    expect(result.reachable).toBe(true);
  });

  it("raises required altitude behind a ridge", () => {
    const heights = new Float32Array(25);
    for (let y = 0; y < 5; y++) {
      heights[y * 5 + 3] = 30;
    }

    const result = evaluateHeightFieldLos(heights, 5, 5, defaultAnalysis, { u: 1, v: 0.5 }, 8);

    expect(result.requiredAltitudeM).toBeGreaterThan(defaultAnalysis.altitude.minM);
    expect(result.reachable).toBe(true);
  });

  it("marks terrain that exceeds the configured altitude as unreachable", () => {
    const heights = new Float32Array(25);
    heights[2 * 5 + 3] = 250;
    const request = {
      ...defaultAnalysis,
      altitude: { ...defaultAnalysis.altitude, maxM: 100 },
    };

    const result = evaluateHeightFieldLos(heights, 5, 5, request, { u: 1, v: 0.5 }, 8);

    expect(result.reachable).toBe(false);
  });

  it("counts high target terrain as part of the required altitude", () => {
    const heights = new Float32Array(25);
    heights[2 * 5 + 4] = 180;

    const result = evaluateHeightFieldLos(heights, 5, 5, defaultAnalysis, { u: 1, v: 0.5 }, 8);

    expect(result.requiredAltitudeM).toBeGreaterThan(178.5);
    expect(result.reachable).toBe(false);
  });
});
