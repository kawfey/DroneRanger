import { describe, expect, it } from "vitest";
import { defaultAnalysis } from "../../analysis/defaults";
import {
  analysisRadiusM,
  coverageTextureSizeFor,
  selectedProfilesForMode,
} from "./CoverageRenderer";
import { maxFreeSpaceRangeM } from "../../analysis/rf";

describe("coverage renderer planning", () => {
  it("uses the range slider for LOS mode", () => {
    expect(analysisRadiusM(defaultAnalysis, "los")).toBe(defaultAnalysis.radiusM);
  });

  it("uses the selected profile free-space range for profile modes", () => {
    const video = defaultAnalysis.profiles.find((profile) => profile.id === "video")!;
    expect(analysisRadiusM(defaultAnalysis, "video")).toBeCloseTo(maxFreeSpaceRangeM(video));
  });

  it("uses the limiting selected profile for combined mode", () => {
    const selected = selectedProfilesForMode(defaultAnalysis, "combined");
    expect(analysisRadiusM(defaultAnalysis, "combined")).toBeCloseTo(
      Math.min(...selected.map(maxFreeSpaceRangeM)),
    );
  });

  it("maps grid resolution to texture size with caps", () => {
    expect(coverageTextureSizeFor(2500, 100)).toBe(64);
    expect(coverageTextureSizeFor(2500, 25)).toBe(200);
    expect(coverageTextureSizeFor(10000, 5)).toBe(384);
  });
});
