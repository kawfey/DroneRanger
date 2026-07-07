import { describe, expect, it } from "vitest";
import { combineObstacleElevations } from "./obstructions";

describe("obstruction merge", () => {
  const terrain = new Float32Array([100, 100, 100, 100, 100]);
  const buildings = new Float32Array([0, 15, 0, 12, 0]);
  const canopy = new Float32Array([0, 0, 20, 8, 1]);

  it("keeps terrain only when no obstructions are present", () => {
    expect([...combineObstacleElevations(terrain, null, null, 2)]).toEqual([100, 100, 100, 100, 100]);
  });

  it("adds building height above terrain", () => {
    expect([...combineObstacleElevations(terrain, buildings, null, 2)]).toEqual([100, 115, 100, 112, 100]);
  });

  it("adds canopy height above terrain", () => {
    expect([...combineObstacleElevations(terrain, null, canopy, 2)]).toEqual([100, 100, 120, 108, 100]);
  });

  it("uses max building or canopy height without stacking", () => {
    expect([...combineObstacleElevations(terrain, buildings, canopy, 2)]).toEqual([100, 115, 120, 112, 100]);
  });

  it("ignores canopy below the threshold", () => {
    expect([...combineObstacleElevations(terrain, null, canopy, 10)]).toEqual([100, 100, 120, 100, 100]);
  });
});
