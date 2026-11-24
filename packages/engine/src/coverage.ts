import type { CoverageInfo } from "./recording.js";

/** Statement coverage below this percentage triggers a warning. */
export const COVERAGE_WARNING_THRESHOLD = 60.0;

export const COVERAGE_UNKNOWN_MESSAGE =
  "Test coverage is unknown: it could not be measured. The search will continue.";

/**
 * Computes statement coverage as a percentage rounded to one decimal place.
 * Returns unknown when the file has no statements (total is 0).
 * Callers pass `null` counts (failed or timed-out coverage run) via `computeCoverageFromRaw`.
 */
export function computeCoverage(executed: number, total: number): CoverageInfo {
  if (!Number.isFinite(executed) || !Number.isFinite(total) || total <= 0) {
    return { percent: null, unknown: true, belowThreshold: false };
  }
  const percent = Math.round((executed / total) * 100 * 10) / 10;
  return { percent, unknown: false, belowThreshold: percent < COVERAGE_WARNING_THRESHOLD };
}

/** Converts the Test_Runner's raw counts (null when the run failed or timed out). */
export function computeCoverageFromRaw(
  raw: { executedStatements: number; totalStatements: number } | null | undefined,
): CoverageInfo {
  if (!raw) return { percent: null, unknown: true, belowThreshold: false };
  return computeCoverage(raw.executedStatements, raw.totalStatements);
}

/**
 * Shared warning text for the CLI and Web_UI.
 * Returns the warning when coverage is below 60.0, the unknown message when
 * coverage is unknown, and null otherwise (no message is shown).
 */
export function coverageMessage(coverage: Pick<CoverageInfo, "percent" | "unknown">): string | null {
  if (coverage.unknown || coverage.percent === null) return COVERAGE_UNKNOWN_MESSAGE;
  if (coverage.percent < COVERAGE_WARNING_THRESHOLD) {
    return `Warning: tests cover only ${coverage.percent.toFixed(1)}% of the statements in this file. Moves that pass may not be fully verified.`;
  }
  return null;
}
