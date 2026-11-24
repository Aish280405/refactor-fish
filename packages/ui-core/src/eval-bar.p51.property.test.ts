// Feature: refactor-fish, Property 51: For any pair (score, originalScore) with originalScore < 0, the Eval Bar's fill fraction SHALL be the result of clamping `score` to the range [originalScore, 0] before mapping to a fill percentage, and the displayed label SHALL equal `score` rounded to 1 decimal place.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clampScore, evalBarView, formatScore } from "./eval-bar.js";

/**
 * Exact oracle for "rounded to 1 decimal place". It works on the decimal
 * digits of the number as JavaScript prints it (`String(x)`), using BigInt
 * arithmetic, so it never suffers from binary floating-point drift.
 * Ties (`.x5`) round half away from zero, matching `Number.prototype.toFixed`
 * and the usual human expectation (1.25 -> 1.3, -1.25 -> -1.3). A result of
 * zero is printed without a sign ("0.0", never "-0.0").
 */
function oracleRound1(x: number): string {
  const negative = x < 0;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(x)));
  if (!match) throw new Error(`unexpected number format: ${String(x)}`);
  const intPart = match[1]!;
  const fracPart = match[2] ?? "";
  const digits = BigInt(intPart + fracPart);
  // value = digits * 10^exp; we want n = round(value * 10).
  const shift = Number(match[3] ?? "0") - fracPart.length + 1;
  let n: bigint;
  if (shift >= 0) {
    n = digits * 10n ** BigInt(shift);
  } else {
    const d = 10n ** BigInt(-shift);
    n = digits / d;
    if (2n * (digits % d) >= d) n += 1n;
  }
  const sign = negative && n > 0n ? "-" : "";
  return `${sign}${n / 10n}.${n % 10n}`;
}

/** Strictly negative original scores, including round and fractional values. */
const arbOriginal = fc.oneof(
  fc.integer({ min: -100_000, max: -1 }).map((k) => k / 100),
  fc.double({ min: -1_000, max: -1e-6, noNaN: true }),
);

/**
 * Scores: centipawn-style values (k / 100, which hit every `.x5` tie),
 * exactly representable quarter values (k / 4, e.g. 1.25, -0.75), and
 * arbitrary doubles. Ranges extend beyond [originalScore, 0] on both sides.
 */
const arbScore = fc.oneof(
  fc.integer({ min: -200_000, max: 100_000 }).map((k) => k / 100),
  fc.integer({ min: -4_000, max: 2_000 }).map((k) => k / 4),
  fc.double({ min: -2_000, max: 1_000, noNaN: true }),
);

describe("Property 51: eval bar scale clamping and rounding", () => {
  it("oracle sanity checks", () => {
    expect(oracleRound1(-1.26)).toBe("-1.3");
    expect(oracleRound1(0.15)).toBe("0.2");
    expect(oracleRound1(-1.25)).toBe("-1.3");
    expect(oracleRound1(-0.04)).toBe("0.0");
    expect(oracleRound1(1e-7)).toBe("0.0");
    expect(oracleRound1(12)).toBe("12.0");
  });

  it("fill is the clamped score mapped onto [originalScore, 0]", () => {
    fc.assert(
      fc.property(arbScore, arbOriginal, (score, original) => {
        const expectedClamped = score < original ? original : score > 0 ? 0 : score;
        expect(clampScore(score, original)).toBe(expectedClamped);

        const view = evalBarView(score, original);
        expect(view.min).toBe(original);
        expect(view.max).toBe(0);
        expect(view.fill).toBe((expectedClamped - original) / (0 - original));
        expect(view.fill).toBeGreaterThanOrEqual(0);
        expect(view.fill).toBeLessThanOrEqual(1);
        if (score <= original) expect(view.fill).toBe(0);
        if (score >= 0) expect(view.fill).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it("label equals the score rounded to 1 decimal place", () => {
    fc.assert(
      fc.property(arbScore, arbOriginal, (score, original) => {
        const expected = oracleRound1(score);
        expect(evalBarView(score, original).label).toBe(expected);
        expect(formatScore(score)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
