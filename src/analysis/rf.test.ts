import { describe, expect, it } from "vitest";
import { fsplDb, linkMarginDb } from "./rf";
import { defaultProfiles } from "./defaults";

describe("rf math", () => {
  it("computes free-space path loss using km/MHz convention", () => {
    expect(fsplDb(1000, 2400)).toBeCloseTo(100.04, 2);
  });

  it("computes positive margin for default telemetry at short range", () => {
    const telemetry = defaultProfiles.find((profile) => profile.id === "telemetry")!;
    expect(linkMarginDb(500, telemetry)).toBeGreaterThan(0);
  });
});
