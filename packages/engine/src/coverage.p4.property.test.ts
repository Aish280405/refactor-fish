// Feature: refactor-fish, Property 4: For any pair of non-negative integers (executedStatements, totalStatements) with executedStatements ≤ totalStatements, the computed coverage percentage SHALL equal round((executedStatements / totalStatements) * 100, 1) when totalStatements > 0, and the coverage SHALL be reported as unknown when totalStatements = 0.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeCoverage, computeCoverageFromRaw } from "./coverage.js";

/**
 * Exact oracle using integer arithmetic: the percentage in tenths is
 * round-half-up(1000 * executed / total) = floor((2000 * executed + total) / (2 * total)).
 */
function expectedPercent(executed: number, total: number): number {
  const e = BigInt(executed);
  const t = BigInt(total);
  const tenths = (2000n * e + t) / (2n * t);
  return Number(tenths) / 10;
}

/** Totals that divide 2000 produce exact .x5 ties, so rounding at the boundary is exercised. */
const arbTotal = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.constantFrom(1, 2, 3, 7, 8, 16, 40, 80, 400, 2000, 4000, 6000, 16000),
);

const arbCounts = arbTotal.chain((total) =>
  fc.integer({ min: 0, max: total }).map((executed) => ({ executed, total })),
);

describe("Property 4: Coverage percentage formula correctness", () => {
  /** **Validates: Requirements 3.1, 3.4, 3.5** */
  it("matches round(executed / total * 100, 1) when total > 0", () => {
    fc.assert(
      fc.property(arbCounts, ({ executed, total }) => {
        const expected = expectedPercent(executed, total);
        const direct = computeCoverage(executed, total);
        expect(direct.unknown).toBe(false);
        expect(direct.percent).toBe(expected);
        expect(direct.percent).toBeGreaterThanOrEqual(0);
        expect(direct.percent).toBeLessThanOrEqual(100);

        const fromRaw = computeCoverageFromRaw({ executedStatements: executed, totalStatements: total });
        expect(fromRaw).toEqual(direct);
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 3.4, 3.5** */
  it("reports coverage as unknown when total is 0", () => {
    fc.assert(
      fc.property(fc.constant(0), (executed) => {
        for (const c of [
          computeCoverage(executed, 0),
          computeCoverageFromRaw({ executedStatements: executed, totalStatements: 0 }),
        ]) {
          expect(c.unknown).toBe(true);
          expect(c.percent).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});
