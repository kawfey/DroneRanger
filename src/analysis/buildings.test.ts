import { describe, expect, it } from "vitest";
import { BuildingHeightTileLoader } from "./buildingTiles";
import { buildingHeightM } from "./buildings";

describe("building height fallback", () => {
  it("prefers explicit height", () => {
    expect(buildingHeightM({ properties: { height: 18, render_height: 8 } })).toBe(18);
  });

  it("uses render_height before levels", () => {
    expect(buildingHeightM({ properties: { render_height: "9", "building:levels": 4 } })).toBe(9);
  });

  it("uses 3.1 meters per level", () => {
    expect(buildingHeightM({ properties: { "building:levels": 3 } })).toBeCloseTo(9.3);
  });

  it("falls back to one level", () => {
    expect(buildingHeightM({ properties: {} })).toBe(3.1);
  });
});

describe("building tile loader", () => {
  it("caches parsed tile polygons across height-field builds", async () => {
    const bounds = {
      west: 0.5,
      north: 0.5,
      east: 0.500001,
      south: 0.500001,
    };
    const polygon = {
      rings: [
        [
          { x: bounds.west, y: bounds.north },
          { x: bounds.east, y: bounds.north },
          { x: bounds.east, y: bounds.south },
          { x: bounds.west, y: bounds.south },
          { x: bounds.west, y: bounds.north },
        ],
      ],
      mercatorBounds: bounds,
      heightM: 12,
    };
    let fetchCount = 0;
    let parseCount = 0;
    const loader = new BuildingHeightTileLoader("token", {
      fetchTile: async () => {
        fetchCount++;
        return new ArrayBuffer(0);
      },
      parseTile: () => {
        parseCount++;
        return [polygon];
      },
    });

    const first = await loader.buildHeightField(bounds, 4, 4);
    const second = await loader.buildHeightField(bounds, 4, 4);

    expect(fetchCount).toBe(1);
    expect(parseCount).toBe(1);
    expect(Math.max(...first.buildingHeightsM)).toBe(12);
    expect(Math.max(...second.buildingHeightsM)).toBe(12);
  });
});
