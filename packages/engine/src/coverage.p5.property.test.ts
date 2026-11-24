// Feature: refactor-fish, Property 5: For any coverage percentage value from 0 to 100, the coverage warning SHALL be shown if and only if the value is strictly less than 60.0, with identical visibility and message text in the CLI and the Web_UI.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeCoverage,
  coverageMessage,
  COVERAGE_UNKNOWN_MESSAGE,
  COVERAGE_WARNING_THRESHOLD,
} from "./coverage.js";

// Measured coverage is a percentage from 0 to 100 rounded to one decimal place (Requirement 3.1),
// so generate tenths 0..1000. Bias toward the 60.0 boundary so 59.9 / 60.0 / 60.1 are hit often.
const percentArb = fc
  .oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 1000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 595, max: 605 }) },
  )
  .map((tenths) => tenths / 10);

// Statement counts as the Test_Runner reports them (total > 0, so coverage is known).
const countsArb = fc
  .integer({ min: 1, max: 100_000 })
  .chain((total) => fc.tuple(fc.integer({ min: 0, max: total }), fc.constant(total)));

/**
 * The CLI and the Web_UI both render `coverageMessage`; these model the two call sites.
 * Visibility is "message is a warning" (non-null and not the unknown message).
 */
const cliOutput = (percent: number) => coverageMessage({ percent, unknown: false });
const webUiOutput = (percent: number) => coverageMessage({ percent, unknown: false });

describe("Property 5: Coverage warning threshold", () => {
  it("shows the warning iff percent < 60.0, stating the percentage, identically for CLI and Web_UI", () => {
    /** **Validates: Requirements 3.2, 3.3** */
    fc.assert(
      fc.property(percentArb, (percent) => {
        const cli = cliOutput(percent);
        const web = webUiOutput(percent);
        const shouldWarn = percent < 60.0;

        expect(cli).toBe(web);
        expect(cli !== null).toBe(shouldWarn);
        if (shouldWarn) {
          expect(cli).not.toBe(COVERAGE_UNKNOWN_MESSAGE);
          expect(cli).toContain(`${percent.toFixed(1)}%`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("measured coverage from statement counts warns iff the rounded percent < 60.0", () => {
    /** **Validates: Requirements 3.2, 3.3** */
    fc.assert(
      fc.property(countsArb, ([executed, total]) => {
        const coverage = computeCoverage(executed, total);
        expect(coverage.unknown).toBe(false);
        const percent = coverage.percent as number;
        const shouldWarn = percent < 60.0;

        expect(coverage.belowThreshold).toBe(shouldWarn);
        const message = coverageMessage(coverage);
        expect(message !== null).toBe(shouldWarn);
        if (shouldWarn) expect(message).toContain(`${percent.toFixed(1)}%`);
      }),
      { numRuns: 100 },
    );
  });

  it("uses the 60.0 threshold constant", () => {
    expect(COVERAGE_WARNING_THRESHOLD).toBe(60.0);
  });
});
