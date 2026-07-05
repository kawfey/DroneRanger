import { describe, expect, it } from "vitest";
import { combinedMaxFreeSpaceRangeM, fsplDb, linkMarginDb, maxFreeSpaceRangeM } from "./rf";
import { defaultProfiles } from "./defaults";

describe("rf math", () => {
  it("computes free-space path loss using km/MHz convention", () => {
    expect(fsplDb(1000, 2400)).toBeCloseTo(100.04, 2);
  });

  it("computes positive margin for default telemetry at short range", () => {
    const telemetry = defaultProfiles.find((profile) => profile.id === "telemetry")!;
    expect(linkMarginDb(500, telemetry)).toBeGreaterThan(0);
  });

  it("computes the zero-margin free-space range", () => {
    const video = defaultProfiles.find((profile) => profile.id === "video")!;
    const range = maxFreeSpaceRangeM(video);
    expect(linkMarginDb(range, video)).toBeCloseTo(0, 6);
  });

  it("uses the limiting profile for combined free-space range", () => {
    const control = defaultProfiles.find((profile) => profile.id === "control")!;
    const video = defaultProfiles.find((profile) => profile.id === "video")!;
    expect(combinedMaxFreeSpaceRangeM([control, video])).toBe(
      Math.min(maxFreeSpaceRangeM(control), maxFreeSpaceRangeM(video)),
    );
  });
});
