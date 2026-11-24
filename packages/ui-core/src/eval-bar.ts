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

export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  // Avoid "-0.0".
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
}

export function evalBarView(score: number, originalScore: number): EvalBarView {
  const min = Math.min(originalScore, 0);
  const clamped = clampScore(score, originalScore);
  const fill = min === 0 ? 1 : (clamped - min) / (0 - min);
  return { fill, label: formatScore(score), min, max: 0 };
}
