import { describe, expect, it } from "vitest";
import { defaultAnalysis } from "./defaults";
import { inspectFlatEarthPixel, inspectTerrainPixel } from "./singleRay";

const flatMap = {
  queryTerrainElevation: () => 0,
};

describe("single ray inspector", () => {
  it("matches flat-earth inspection when terrain is flat", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };

    expect(inspectTerrainPixel(flatMap, defaultAnalysis, target, "combined")).toMatchObject(
      inspectFlatEarthPixel(defaultAnalysis, target, "combined"),
    );
  });

  it("uses terrain blockers to increase required altitude", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };
    const ridgeMap = {
      queryTerrainElevation: (lngLat: { lng: number }) =>
        lngLat.lng > defaultAnalysis.operator.lng + 0.004 &&
        lngLat.lng < defaultAnalysis.operator.lng + 0.006
          ? 80
          : 0,
    };

    const inspected = inspectTerrainPixel(ridgeMap, defaultAnalysis, target, "combined");

    expect(inspected.requiredAltitudeM).toBeGreaterThan(defaultAnalysis.altitude.minM);
    expect(inspected.reachable).toBe(false);
  });
});
