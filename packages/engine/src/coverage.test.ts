import { describe, expect, it } from "vitest";
import { computeCoverage, computeCoverageFromRaw, coverageMessage, COVERAGE_UNKNOWN_MESSAGE } from "./coverage.js";

describe("computeCoverage", () => {
  it("rounds to one decimal", () => {
    expect(computeCoverage(1, 3)).toEqual({ percent: 33.3, unknown: false, belowThreshold: true });
    expect(computeCoverage(3, 5).percent).toBe(60);
  });

  it("is unknown when total is 0 or raw is null", () => {
    expect(computeCoverage(0, 0)).toEqual({ percent: null, unknown: true, belowThreshold: false });
    expect(computeCoverageFromRaw(null).unknown).toBe(true);
  });
});

describe("coverageMessage", () => {
  it("warns below 60.0 and includes the percentage", () => {
    expect(coverageMessage(computeCoverage(599, 1000))).toContain("59.9%");
  });

  it("shows nothing at 60.0 or above", () => {
    expect(coverageMessage(computeCoverage(60, 100))).toBeNull();
    expect(coverageMessage(computeCoverage(100, 100))).toBeNull();
  });

  it("shows the unknown message when unknown", () => {
    expect(coverageMessage(computeCoverage(0, 0))).toBe(COVERAGE_UNKNOWN_MESSAGE);
  });
});
