import type { MoveRecord } from "./types.js";

export const NO_IMPROVEMENT_MESSAGE = "No improvement found.";
export const NO_REFACTORING_MESSAGE = "No refactoring found.";
export const NO_TEXTUAL_CHANGE_MESSAGE = "This move produced no textual change.";

/** `<n>. <Move name> <Annotation>` with 1-based n. */
export function formatMoveEntry(move: Pick<MoveRecord, "displayName" | "annotation">, index: number): string {
  return `${index + 1}. ${move.displayName} ${move.annotation}`;
}

export interface MoveListView {
  entries: string[];
  /** Set (in place of the list) when the Best_Line is empty. */
  emptyMessage: string | null;
}

export function moveListView(bestLine: readonly MoveRecord[]): MoveListView {
  if (bestLine.length === 0) return { entries: [], emptyMessage: NO_IMPROVEMENT_MESSAGE };
  return { entries: bestLine.map((m, i) => formatMoveEntry(m, i)), emptyMessage: null };
}
