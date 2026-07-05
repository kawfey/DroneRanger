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

  it("reports signed minimum elevation change relative to operator altitude", () => {
    const request = {
      ...defaultAnalysis,
      operator: {
        ...defaultAnalysis.operator,
        antennaHeightM: 2,
      },
      altitude: {
        ...defaultAnalysis.altitude,
        minM: 0,
        maxM: 120,
      },
    };
    const target = {
      lng: request.operator.lng + 0.01,
      lat: request.operator.lat,
    };
    const ridgeNearTargetMap = {
      queryTerrainElevation: (lngLat: { lng: number }) => {
        if (lngLat.lng === request.operator.lng) return 98;
        if (lngLat.lng > request.operator.lng + 0.009) return 50;
        return 0;
      },
    };

    const inspected = inspectTerrainPixel(ridgeNearTargetMap, request, target, "los");

    expect(inspected.operatorAltitudeAslM).toBe(100);
    expect(inspected.requiredElevationChangeM).toBeLessThan(0);
    expect(inspected.requiredElevationChangeM).toBeCloseTo(-50, 1);
  });
});
