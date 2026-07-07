import { describe, expect, it } from "vitest";
import { coveringVegetationTiles, metaChmTileUrl, VegetationHeightTileLoader } from "./vegetationTiles";

describe("Meta CHM vegetation tiles", () => {
  it("builds z10 quadkey Source Cooperative URLs", () => {
    expect(metaChmTileUrl({ z: 10, x: 511, y: 340 })).toBe(
      "https://data.source.coop/tge-labs/meta-chm-v2/chm/0313131311.tif",
    );
  });

  it("covers known mercator bounds at z10", () => {
    const tiles = coveringVegetationTiles({
      west: 511 / 1024,
      north: 340 / 1024,
      east: 513 / 1024,
      south: 342 / 1024,
    });

    expect(tiles).toEqual([
      { z: 10, x: 511, y: 340 },
      { z: 10, x: 512, y: 340 },
      { z: 10, x: 511, y: 341 },
      { z: 10, x: 512, y: 341 },
    ]);
  });

  it("resamples mocked canopy tile data into the analysis grid", async () => {
    const loader = new VegetationHeightTileLoader({
      loadTile: async () => ({
        width: 2,
        height: 2,
        canopyHeightsM: new Float32Array([0, 10, 20, 30]),
      }),
    });

    const field = await loader.buildHeightField(
      {
        west: 511 / 1024,
        north: 340 / 1024,
        east: 512 / 1024,
        south: 341 / 1024,
      },
      2,
      2,
    );

    expect([...field.canopyHeightsM]).toEqual([0, 10, 20, 30]);
    expect(field.failedTileCount).toBe(0);
  });

  it("keeps available canopy data when an intersecting CHM tile fails", async () => {
    const warnings: string[] = [];
    const loader = new VegetationHeightTileLoader({
      onWarning: (message) => warnings.push(message),
      loadTile: async (tile) => {
        if (tile.x === 512) {
          throw new Error("Failed to fetch");
        }
        return {
          width: 1,
          height: 1,
          canopyHeightsM: new Float32Array([12]),
        };
      },
    });

    const field = await loader.buildHeightField(
      {
        west: 511 / 1024,
        north: 340 / 1024,
        east: 513 / 1024,
        south: 341 / 1024,
      },
      2,
      1,
    );

    expect([...field.canopyHeightsM]).toEqual([12, 0]);
    expect(field.failedTileCount).toBe(1);
    expect(warnings[0]).toContain("Vegetation CHM unavailable for 1 of 2 tiles");
  });

  it("does not keep rejected tile promises in cache", async () => {
    let attempts = 0;
    const loader = new VegetationHeightTileLoader({
      loadTile: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("Failed to fetch");
        }
        return {
          width: 1,
          height: 1,
          canopyHeightsM: new Float32Array([9]),
        };
      },
    });
    const bounds = {
      west: 511 / 1024,
      north: 340 / 1024,
      east: 512 / 1024,
      south: 341 / 1024,
    };

    expect((await loader.buildHeightField(bounds, 1, 1)).failedTileCount).toBe(1);
    expect([...(await loader.buildHeightField(bounds, 1, 1)).canopyHeightsM]).toEqual([9]);
    expect(attempts).toBe(2);
  });
});
