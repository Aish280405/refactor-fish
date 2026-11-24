import type { Metrics } from "./types.js";

export const UNAVAILABLE = "unavailable";

export type ChangeMark = "improved" | "worsened" | "unchanged";

export const METRIC_KEYS = [
  "cyclomaticComplexity",
  "maxNestingDepth",
  "functionLength",
  "duplicatedCode",
  "unusedCode",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABELS: Record<MetricKey, string> = {
  cyclomaticComplexity: "Cyclomatic complexity",
  maxNestingDepth: "Max nesting depth",
  functionLength: "Function length",
  duplicatedCode: "Duplicated code",
  unusedCode: "Unused code",
};

/** Text + symbol so the mark is not color-only. */
export const MARK_DISPLAY: Record<ChangeMark, { text: string; symbol: string }> = {
  improved: { text: "improved", symbol: "▼" },
  worsened: { text: "worsened", symbol: "▲" },
  unchanged: { text: "unchanged", symbol: "=" },
};

export function formatMetricValue(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNAVAILABLE;
  return String(Math.round(value));
}

/** Signed whole-number change ("+2", "-1", "0"). */
export function formatChange(change: number): string {
  const r = Math.round(change);
  if (r === 0) return "0";
  return r > 0 ? `+${r}` : `-${Math.abs(r)}`;
}

export function changeMark(change: number): ChangeMark {
  const r = Math.round(change);
  return r < 0 ? "improved" : r > 0 ? "worsened" : "unchanged";
}

export interface MetricRowView {
  key: MetricKey;
  label: string;
  original: string;
  selected: string;
  /** Signed change text, or "unavailable" if either side is missing. */
  change: string;
  /** null when the change is unavailable. */
  mark: ChangeMark | null;
  markText: string | null;
  markSymbol: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function metricRow(
  key: MetricKey,
  original: Partial<Metrics> | null | undefined,
  selected: Partial<Metrics> | null | undefined,
): MetricRowView {
  const o = original?.[key];
  const s = selected?.[key];
  const base = {
    key,
    label: METRIC_LABELS[key],
    original: formatMetricValue(o),
    selected: formatMetricValue(s),
  };
  if (isNum(o) && isNum(s)) {
    const delta = Math.round(s) - Math.round(o);
    const mark = changeMark(delta);
    return {
      ...base,
      change: formatChange(delta),
      mark,
      markText: MARK_DISPLAY[mark].text,
      markSymbol: MARK_DISPLAY[mark].symbol,
    };
  }
  return { ...base, change: UNAVAILABLE, mark: null, markText: null, markSymbol: null };
}

/**
 * Metrics panel rows. When no Move is selected (selected === null by caller choice via `noSelection`),
 * the original values are shown as the selected values.
 */
export function metricsPanelView(
  original: Partial<Metrics> | null | undefined,
  selected: Partial<Metrics> | null | undefined,
  noSelection = false,
): MetricRowView[] {
  const sel = noSelection ? original : selected;
  return METRIC_KEYS.map((k) => metricRow(k, original, sel));
}
