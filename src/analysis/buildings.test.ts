import { describe, expect, it } from "vitest";
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
