import { describe, expect, it, vi } from "vitest";
import { defaultAnalysis } from "./defaults";
import { earthRadiusM, haversineDistanceM } from "./coordinates";
import { inspectFlatEarthPixel, inspectTerrainPixel } from "./singleRay";

const flatMap = {
  queryTerrainElevation: () => 0,
};

/** Drone height needed at ground distance D over a smooth earth: D = √(2kR·h₁) + √(2kR·h₂). */
function radioHorizonDroneHeightM(distanceM: number, antennaHeightM: number, k: number): number {
  const twoKR = 2 * k * earthRadiusM;
  const antennaHorizonM = Math.sqrt(twoKR * antennaHeightM);
  return Math.max(0, distanceM - antennaHorizonM) ** 2 / twoKR;
}

describe("earth curvature", () => {
  const longRange = {
    ...defaultAnalysis,
    radiusM: 60000,
    calculationRange: { mode: "manual" as const, manualM: 60000 },
    altitude: { minM: 0, maxM: 500 },
  };
  const targetAtKm = (km: number) => ({
    lng: longRange.operator.lng + km / 84.76,
    lat: longRange.operator.lat,
  });

  it.each([20, 50])("reproduces the radio horizon over flat ground at %i km", (km) => {
    const target = targetAtKm(km);
    const distanceM = haversineDistanceM(longRange.operator, target);
    const expectedM = radioHorizonDroneHeightM(distanceM, longRange.operator.antennaHeightM, 4 / 3);

    const inspected = inspectTerrainPixel(flatMap, longRange, target, "los");

    // The oracle is height above ground; discrete sampling can only miss the true limiting point, never exceed it.
    expect(inspected.minDroneAltitudeAglM).toBeLessThanOrEqual(expectedM + 0.01);
    expect(inspected.minDroneAltitudeAglM).toBeGreaterThan(expectedM * 0.98);
    expect(inspected.earthBulgeAtLimitM).toBeGreaterThan(0);
  });

  it("needs more altitude without refraction than with the standard atmosphere", () => {
    const target = targetAtKm(30);
    const geometric = inspectTerrainPixel(
      flatMap,
      { ...longRange, propagation: { effectiveEarthRadiusK: 1 } },
      target,
      "los",
    );
    const standard = inspectTerrainPixel(flatMap, longRange, target, "los");

    expect(geometric.requiredElevationChangeM).toBeGreaterThan(standard.requiredElevationChangeM);
  });

  it("keeps the flat vertical profile when curvature is off", () => {
    const inspected = inspectTerrainPixel(
      flatMap,
      { ...longRange, propagation: { effectiveEarthRadiusK: null } },
      targetAtKm(50),
      "los",
    );

    expect(inspected.requiredElevationChangeM).toBe(0);
    expect(inspected.earthBulgeAtLimitM).toBe(0);
  });

  it("applies curvature to the no-terrain inspection too", () => {
    const target = targetAtKm(50);

    expect(inspectFlatEarthPixel(longRange, target, "los")).toEqual(
      inspectTerrainPixel(flatMap, longRange, target, "los"),
    );
    expect(inspectFlatEarthPixel(longRange, target, "los").requiredElevationChangeM).toBeGreaterThan(100);
  });
});

describe("fresnel diagnostics", () => {
  const target = {
    lng: defaultAnalysis.operator.lng + 0.01,
    lat: defaultAnalysis.operator.lat,
  };
  const ridgeMap = {
    queryTerrainElevation: (lngLat: { lng: number }) =>
      lngLat.lng > defaultAnalysis.operator.lng + 0.004 && lngLat.lng < defaultAnalysis.operator.lng + 0.006
        ? 20
        : 0,
  };

  it("reports the clearance altitude without enforcing it", () => {
    const inspected = inspectTerrainPixel(flatMap, defaultAnalysis, target, "combined");

    expect(inspected.requiredElevationChangeM).toBe(0);
    expect(inspected.fresnelRadiusAtLimitM).toBeNull();
    expect(inspected.fresnelClearElevationChangeM).toBeGreaterThan(0);
    expect(inspected.fresnelClearAglM).toBeGreaterThan(inspected.fresnelClearElevationChangeM ?? 0);
  });

  it("reports the zone radius at the obstacle that limits the ray", () => {
    const inspected = inspectTerrainPixel(ridgeMap, defaultAnalysis, target, "combined");

    expect(inspected.requiredElevationChangeM).toBeGreaterThan(0);
    expect(inspected.fresnelRadiusAtLimitM).toBeGreaterThan(0);
    expect(inspected.fresnelClearElevationChangeM).toBeGreaterThan(inspected.requiredElevationChangeM);
  });

  it("skips Fresnel diagnostics in geometric modes", () => {
    const inspected = inspectTerrainPixel(ridgeMap, defaultAnalysis, target, "los");

    expect(inspected.fresnelRadiusAtLimitM).toBeNull();
    expect(inspected.fresnelClearElevationChangeM).toBeNull();
    expect(inspected.fresnelClearAglM).toBeNull();
  });
});

describe("single ray inspector", () => {
  it("matches flat-earth inspection when terrain is flat", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };

    expect(inspectTerrainPixel(flatMap, defaultAnalysis, target, "combined")).toMatchObject(
      inspectFlatEarthPixel(defaultAnalysis, target, "combined"),
    );
    expect(inspectTerrainPixel(flatMap, defaultAnalysis, target, "combined").violationCriteria).toBe(
      "None",
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
    expect(inspected.violationCriteria).toBe("Terrain");
  });

  it("requires altitude when the target terrain is higher than the operator", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };
    const highTargetMap = {
      queryTerrainElevation: (lngLat: { lng: number }) =>
        lngLat.lng === target.lng ? 180 : 0,
    };

    const inspected = inspectTerrainPixel(highTargetMap, defaultAnalysis, target, "los");

    expect(inspected.requiredElevationChangeM).toBeCloseTo(178.5);
    expect(inspected.reachable).toBe(false);
    expect(inspected.violationCriteria).toBe("Terrain");
  });

  it("uses Mapbox building blockers only when enabled", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };
    const buildingMap = {
      queryTerrainElevation: () => 0,
      project: (lngLat: { lng: number; lat: number }) => ({ x: lngLat.lng, y: lngLat.lat }),
      getLayer: (id: string) => (id === "los-building-reference" ? {} : undefined),
      queryRenderedFeatures: (point: { x: number }) =>
        point.x > defaultAnalysis.operator.lng + 0.004 &&
        point.x < defaultAnalysis.operator.lng + 0.006
          ? [{ properties: { height: 80 } }]
          : [],
    };

    const withoutBuildings = inspectTerrainPixel(
      buildingMap,
      { ...defaultAnalysis, includeBuildings: false },
      target,
      "combined",
    );
    const withBuildings = inspectTerrainPixel(
      buildingMap,
      { ...defaultAnalysis, includeBuildings: true },
      target,
      "combined",
    );

    expect(withoutBuildings.requiredAltitudeM).toBe(defaultAnalysis.altitude.minM);
    expect(withBuildings.requiredAltitudeM).toBeGreaterThan(withoutBuildings.requiredAltitudeM);
    expect(withBuildings.reachable).toBe(false);
    expect(withBuildings.violationCriteria).toBe("Building");
  });

  it("prefers fixed building height samples over rendered feature queries", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };
    const queryRenderedFeatures = vi.fn(() => []);
    const fixedBuildingMap = {
      queryTerrainElevation: () => 0,
      queryBuildingHeightM: (lngLat: { lng: number }) =>
        lngLat.lng > defaultAnalysis.operator.lng + 0.004 &&
        lngLat.lng < defaultAnalysis.operator.lng + 0.006
          ? 80
          : 0,
      project: (lngLat: { lng: number; lat: number }) => ({ x: lngLat.lng, y: lngLat.lat }),
      getLayer: (id: string) => (id === "los-building-reference" ? {} : undefined),
      queryRenderedFeatures,
    };

    const inspected = inspectTerrainPixel(
      fixedBuildingMap,
      { ...defaultAnalysis, includeBuildings: true },
      target,
      "combined",
    );

    expect(queryRenderedFeatures).not.toHaveBeenCalled();
    expect(inspected.requiredAltitudeM).toBeGreaterThan(defaultAnalysis.altitude.minM);
    expect(inspected.violationCriteria).toBe("Building");
  });

  it("reports vegetation blockers separately from terrain", () => {
    const request = {
      ...defaultAnalysis,
      includeVegetation: true,
      altitude: {
        ...defaultAnalysis.altitude,
        maxM: 60,
      },
      vegetation: {
        ...defaultAnalysis.vegetation,
        minCanopyHeightM: 1,
      },
    };
    const target = {
      lng: request.operator.lng + 0.01,
      lat: request.operator.lat,
    };
    const canopyMap = {
      queryTerrainElevation: () => 0,
      queryVegetationHeightM: (lngLat: { lng: number }) =>
        lngLat.lng > request.operator.lng + 0.004 && lngLat.lng < request.operator.lng + 0.006
          ? 80
          : 0,
    };

    const inspected = inspectTerrainPixel(canopyMap, request, target, "combined");

    expect(inspected.requiredAltitudeM).toBeGreaterThan(request.altitude.maxM);
    expect(inspected.reachable).toBe(false);
    expect(inspected.violationCriteria).toBe("Vegetation");
  });

  it("distinguishes manual range cutoffs from RF-derived auto limits", () => {
    const target = {
      lng: defaultAnalysis.operator.lng + 0.01,
      lat: defaultAnalysis.operator.lat,
    };
    const manualRange = inspectTerrainPixel(
      flatMap,
      {
        ...defaultAnalysis,
        calculationRange: { mode: "manual", manualM: 250 },
      },
      target,
      "combined",
    );
    const autoRf = inspectTerrainPixel(
      flatMap,
      {
        ...defaultAnalysis,
        profiles: defaultAnalysis.profiles.map((profile) => ({
          ...profile,
          txPowerDbm: -100,
          rxSensitivityDbm: -50,
        })),
        calculationRange: { mode: "auto", manualM: 5000 },
      },
      target,
      "combined",
    );

    expect(manualRange.violationCriteria).toBe("Range");
    expect(autoRf.violationCriteria).toBe("RF");
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
    expect(inspected.requiredElevationChangeM).toBe(0);
  });

  it("keeps AGL altitude unsigned below the operator", () => {
    const request = {
      ...defaultAnalysis,
      altitudeCriterion: "agl" as const,
      altitude: {
        ...defaultAnalysis.altitude,
        minM: 0,
        maxM: 1,
      },
    };
    const target = {
      lng: request.operator.lng + 0.01,
      lat: request.operator.lat,
    };
    const downhillMap = {
      queryTerrainElevation: (lngLat: { lng: number }) =>
        lngLat.lng === request.operator.lng ? 100 : 0,
    };

    const inspected = inspectTerrainPixel(downhillMap, request, target, "los");

    expect(inspected.requiredElevationChangeM).toBeLessThan(0);
    expect(inspected.minDroneAltitudeAglM).toBe(0);
    expect(inspected.reachable).toBe(true);
    expect(inspected.violationCriteria).toBe("None");
  });

  it("marks points unreachable when required elevation change exceeds max altitude", () => {
    const request = {
      ...defaultAnalysis,
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
    const ridgeMap = {
      queryTerrainElevation: (lngLat: { lng: number }) =>
        lngLat.lng > request.operator.lng + 0.004 && lngLat.lng < request.operator.lng + 0.006
          ? 200
          : 0,
    };

    const inspected = inspectTerrainPixel(ridgeMap, request, target, "los");

    expect(inspected.requiredElevationChangeM).toBeGreaterThan(request.altitude.maxM);
    expect(inspected.requiredAltitudeM).toBe(inspected.requiredElevationChangeM);
    expect(inspected.reachable).toBe(false);
    expect(inspected.violationCriteria).toBe("Terrain");
  });
});
