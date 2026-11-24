export interface EvalBarView {
  /** Fill fraction in [0, 1]; 0 = at the original (worst) score, 1 = score 0. */
  fill: number;
  /** Numeric score label rounded to 1 decimal place. */
  label: string;
  min: number;
  max: 0;
}

/** Clamp a score into [originalScore, 0]. Non-finite or degenerate input yields originalScore/0 bounds safely. */
export function clampScore(score: number, originalScore: number): number {
  const min = Math.min(originalScore, 0);
  if (Number.isNaN(score)) return min;
  return Math.min(0, Math.max(min, score));
}

/**
 * Round to 1 decimal place, half away from zero, based on the number's printed
 * decimal digits (`String(x)`, the shortest round-trip form). Uses BigInt
 * arithmetic so binary float drift cannot affect ties (1.45 -> "1.5",
 * -98.25 -> "-98.3"). A zero result is always "0.0", never "-0.0".
 * Non-finite input falls back to `toFixed(1)` ("NaN", "Infinity", "-Infinity").
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return score.toFixed(1);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(score)));
  if (!match) return score.toFixed(1);
  const fracPart = match[2] ?? "";
  const digits = BigInt(match[1]! + fracPart);
  // |score| = digits * 10^(exp - fracLen); we want n = round(|score| * 10).
  const shift = Number(match[3] ?? "0") - fracPart.length + 1;
  let n: bigint;
  if (shift >= 0) {
    n = digits * 10n ** BigInt(shift);
  } else {
    const d = 10n ** BigInt(-shift);
    n = digits / d;
    if (2n * (digits % d) >= d) n += 1n;
  }
  const sign = score < 0 && n > 0n ? "-" : "";
  return `${sign}${n / 10n}.${n % 10n}`;
}

export function evalBarView(score: number, originalScore: number): EvalBarView {
  const min = Math.min(originalScore, 0);
  const clamped = clampScore(score, originalScore);
  const fill = min === 0 ? 1 : (clamped - min) / (0 - min);
  return { fill, label: formatScore(score), min, max: 0 };
}
