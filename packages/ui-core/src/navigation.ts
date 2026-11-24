import type { MoveRecord } from "./types.js";

export interface NavigationState {
  /** 0-based selected index, or null when nothing is selected. */
  selectedIndex: number | null;
  total: number;
  /** 1-based index for display, or null. */
  displayIndex: number | null;
  previousDisabled: boolean;
  nextDisabled: boolean;
  jumpToEndDisabled: boolean;
  /** True when the Best_Line is empty ("no refactoring found"; no diff). */
  empty: boolean;
}

/** Initial selection on load: first Move if any, else null. */
export function initialSelection(total: number): number | null {
  return total > 0 ? 0 : null;
}

export function navigationState(selectedIndex: number | null, total: number): NavigationState {
  if (total <= 0) {
    return {
      selectedIndex: null,
      total: 0,
      displayIndex: null,
      previousDisabled: true,
      nextDisabled: true,
      jumpToEndDisabled: true,
      empty: true,
    };
  }
  const sel = selectedIndex === null ? null : Math.min(Math.max(selectedIndex, 0), total - 1);
  return {
    selectedIndex: sel,
    total,
    displayIndex: sel === null ? null : sel + 1,
    previousDisabled: sel === null || sel <= 0,
    nextDisabled: sel === null || sel >= total - 1,
    jumpToEndDisabled: false,
    empty: false,
  };
}

export function previousIndex(selectedIndex: number | null, total: number): number | null {
  const s = navigationState(selectedIndex, total);
  if (s.previousDisabled || s.selectedIndex === null) return s.selectedIndex;
  return s.selectedIndex - 1;
}

export function nextIndex(selectedIndex: number | null, total: number): number | null {
  const s = navigationState(selectedIndex, total);
  if (s.nextDisabled || s.selectedIndex === null) return s.selectedIndex;
  return s.selectedIndex + 1;
}

export function jumpToEndIndex(selectedIndex: number | null, total: number): number | null {
  return total > 0 ? total - 1 : null;
}

export interface DiffSources {
  before: string;
  after: string;
}

/** Sources for the selected move's diff, or null when the line is empty. */
export function moveDiffSources(bestLine: readonly MoveRecord[], selectedIndex: number | null): DiffSources | null {
  if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= bestLine.length) return null;
  const m = bestLine[selectedIndex]!;
  return { before: m.sourceBefore, after: m.sourceAfter };
}

/** Cumulative diff sources for "jump to end": original source to the final position. */
export function cumulativeDiffSources(originalSource: string, bestLine: readonly MoveRecord[]): DiffSources | null {
  if (bestLine.length === 0) return null;
  return { before: originalSource, after: bestLine[bestLine.length - 1]!.sourceAfter };
}

export function hasNoTextualChange(before: string, after: string): boolean {
  return before === after;
}
