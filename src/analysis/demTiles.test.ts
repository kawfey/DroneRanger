import { describe, expect, it } from "vitest";
import { defaultAnalysis } from "./defaults";
import {
  analysisMercatorBounds,
  chooseDemZoom,
  coveringDemTiles,
  mapboxTerrainDemMaxZoom,
  mapboxTerrainRgbElevationM,
  mercatorToTextureUv,
} from "./demTiles";
import { lngLatToMercator01 } from "./coordinates";

describe("DEM tile math", () => {
  it("decodes Mapbox RGB terrain elevations", () => {
    expect(mapboxTerrainRgbElevationM(1, 134, 160)).toBe(0);
    expect(mapboxTerrainRgbElevationM(1, 135, 4)).toBe(10);
  });

  it("selects covering tiles for analysis bounds", () => {
    const bounds = analysisMercatorBounds(defaultAnalysis, defaultAnalysis.radiusM);
    const zoom = chooseDemZoom(defaultAnalysis, defaultAnalysis.radiusM);
    const tiles = coveringDemTiles(bounds, zoom);

    expect(zoom).toBeLessThanOrEqual(mapboxTerrainDemMaxZoom);
    expect(tiles.length).toBeGreaterThan(0);
    expect(new Set(tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`)).size).toBe(tiles.length);
  });

  it("maps operator mercator coordinates to texture center", () => {
    const bounds = analysisMercatorBounds(defaultAnalysis, defaultAnalysis.radiusM);
    const uv = mercatorToTextureUv(
      lngLatToMercator01(defaultAnalysis.operator.lng, defaultAnalysis.operator.lat),
      bounds,
    );

    expect(uv.u).toBeCloseTo(0.5, 6);
    expect(uv.v).toBeCloseTo(0.5, 6);
  });
});
