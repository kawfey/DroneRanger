import { describe, expect, it } from "vitest";
import { haversineDistanceM, lngLatToMercator01, metersToMercatorUnits } from "./coordinates";

describe("coordinates", () => {
  it("maps lng/lat origin to web mercator center", () => {
    expect(lngLatToMercator01(0, 0)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("converts meters to mercator units at equator", () => {
    expect(metersToMercatorUnits(1000, 0)).toBeCloseTo(0.00002495, 8);
  });

  it("computes short haversine distances", () => {
    expect(haversineDistanceM({ lng: 0, lat: 0 }, { lng: 0.01, lat: 0 })).toBeCloseTo(1112, -1);
  });
});
