// Feature: refactor-fish, Property 44: Annotation function correctness
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { annotate } from "./annotator.js";
import type { Annotation } from "./types.js";

/**
 * Spec oracle using exact integer arithmetic (no floating-point rounding):
 * gain/range >= 15%  <=>  100*gain >= 15*range  (range > 0).
 */
function expectedLegal(gain: bigint, range: bigint): Annotation {
  if (range === 0n) return "?!";
  if (100n * gain >= 15n * range) return "!!";
  if (100n * gain >= 5n * range) return "!";
  return "?!";
}

/** The Engine's annotation for a Move: Blunders are `??`, Legal_Moves use annotate(). */
function annotateMove(isBlunder: boolean, gain: number, range: number): Annotation {
  return isBlunder ? "??" : annotate(gain, range);
}

const SAFE = 1_000_000_000;

/** Original Score (<= 0 on the Evaluator scale); range is |originalScore| (Req 15.5). */
const arbOriginalScore = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 4, arbitrary: fc.integer({ min: -SAFE, max: 0 }) },
);

/** Gains spread over all bands, with extra weight on the 5% and 15% boundaries. */
function arbGain(range: number): fc.Arbitrary<number> {
  const at = (pct: number) => Math.ceil((pct * range) / 100);
  return fc.oneof(
    fc.integer({ min: -SAFE, max: SAFE }),
    fc.integer({ min: -range - 1, max: range + 1 }),
    fc.constantFrom(0, at(5), at(5) - 1, at(15), at(15) - 1),
  );
}

describe("Property 44: Annotation function correctness", () => {
  /** **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6** */
  it("annotates Blunders ?? and Legal_Moves by the 15%/5% thresholds of |original Score|", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        arbOriginalScore.chain((originalScore) => {
          const range = Math.abs(originalScore);
          return fc.tuple(fc.constant(range), arbGain(range));
        }),
        (isBlunder, [range, gain]) => {
          const actual = annotateMove(isBlunder, gain, range);
          if (isBlunder) {
            expect(actual).toBe("??");
            return;
          }
          // Legal_Moves are never annotated ?? (Req 15.4) and follow the thresholds.
          const legal = annotate(gain, range);
          expect(legal).not.toBe("??");
          expect(legal).toBe(expectedLegal(BigInt(gain), BigInt(range)));
          if (range === 0) expect(legal).toBe("?!"); // Req 15.6
          if (gain <= 0) expect(legal).toBe("?!"); // Req 15.3 zero/negative
        },
      ),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 15.1, 15.2, 15.3, 15.6** */
  it("matches the ratio thresholds for fractional gains and ranges away from the boundaries", () => {
    const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(
        finite,
        fc.oneof(fc.constant(0), fc.double({ min: 1e-3, max: 1e6, noNaN: true })),
        (gain, range) => {
          const actual = annotate(gain, range);
          if (range === 0) {
            expect(actual).toBe("?!");
            return;
          }
          const ratio = gain / range;
          fc.pre(Math.abs(ratio - 0.15) > 1e-9 && Math.abs(ratio - 0.05) > 1e-9);
          const expected = ratio >= 0.15 ? "!!" : ratio >= 0.05 ? "!" : "?!";
          expect(actual).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
