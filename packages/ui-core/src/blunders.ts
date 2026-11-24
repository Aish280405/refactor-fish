import type { BlunderRecord } from "./types.js";

export const EMPTY_MESSAGE_INDICATOR = "(no message)";
export const NO_BLUNDERS_MESSAGE = "No moves broke tests.";

export interface BlunderTestView {
  testName: string;
  message: string;
  hasMessage: boolean;
}

export interface BlunderEntryView {
  moveName: string;
  /** 1-based position of the Move in its Line. */
  position: number;
  failingTests: BlunderTestView[];
  failureReason?: "timeout" | "test execution error";
}

export interface BlunderLogView {
  entries: BlunderEntryView[];
  /** Set when there are no Blunders. */
  emptyMessage: string | null;
}

export function blunderLogView(blunders: readonly BlunderRecord[]): BlunderLogView {
  const entries = blunders.map((b): BlunderEntryView => {
    const e: BlunderEntryView = {
      moveName: b.moveDescription,
      position: b.lineIndex,
      failingTests: b.failingTests.map((t) => {
        const hasMessage = t.message !== undefined && t.message !== "";
        return { testName: t.testName, message: hasMessage ? t.message! : EMPTY_MESSAGE_INDICATOR, hasMessage };
      }),
    };
    if (b.failureReason !== undefined) e.failureReason = b.failureReason;
    return e;
  });
  return { entries, emptyMessage: entries.length === 0 ? NO_BLUNDERS_MESSAGE : null };
}
