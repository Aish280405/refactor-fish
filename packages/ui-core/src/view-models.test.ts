import { describe, expect, it } from "vitest";
import {
  blunderLogView,
  EMPTY_MESSAGE_INDICATOR,
  evalBarView,
  formatMoveEntry,
  hasNoTextualChange,
  jumpToEndIndex,
  lineDiff,
  metricsPanelView,
  moveListView,
  navigationState,
  nextIndex,
  previousIndex,
  UNAVAILABLE,
} from "./index.js";

const m = (n: number) => ({
  cyclomaticComplexity: n,
  maxNestingDepth: n,
  functionLength: n,
  duplicatedCode: n,
  unusedCode: n,
});

describe("eval bar", () => {
  it("clamps and rounds", () => {
    expect(evalBarView(-5, -10)).toMatchObject({ fill: 0.5, label: "-5.0" });
    expect(evalBarView(-20, -10).fill).toBe(0);
    expect(evalBarView(3, -10).fill).toBe(1);
    expect(evalBarView(-1.26, -10).label).toBe("-1.3");
  });
});

describe("navigation", () => {
  it("handles bounds and empty", () => {
    expect(navigationState(0, 3)).toMatchObject({ previousDisabled: true, nextDisabled: false, displayIndex: 1 });
    expect(navigationState(2, 3).nextDisabled).toBe(true);
    expect(navigationState(null, 0)).toMatchObject({ empty: true, jumpToEndDisabled: true });
    expect(previousIndex(0, 3)).toBe(0);
    expect(previousIndex(2, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(2);
    expect(nextIndex(0, 3)).toBe(1);
    expect(jumpToEndIndex(0, 3)).toBe(2);
  });
});

describe("diff", () => {
  it("marks added, removed, unchanged", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "unchanged", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "unchanged", text: "c" },
    ]);
    expect(hasNoTextualChange("a", "a")).toBe(true);
    expect(hasNoTextualChange("a", "b")).toBe(false);
  });
});

describe("metrics", () => {
  it("formats changes and marks", () => {
    const rows = metricsPanelView(m(3), { ...m(3), cyclomaticComplexity: 1, unusedCode: 5 });
    expect(rows[0]).toMatchObject({ change: "-2", mark: "improved", markText: "improved" });
    expect(rows[1]).toMatchObject({ change: "0", mark: "unchanged" });
    expect(rows[4]).toMatchObject({ change: "+2", mark: "worsened" });
  });
  it("shows unavailable but keeps available values", () => {
    const rows = metricsPanelView(m(3), undefined);
    expect(rows[0]).toMatchObject({ original: "3", selected: UNAVAILABLE, change: UNAVAILABLE, mark: null });
  });
  it("uses original as selected when no selection", () => {
    expect(metricsPanelView(m(3), m(9), true)[0]).toMatchObject({ selected: "3", change: "0" });
  });
});

describe("blunders and move list", () => {
  it("shows indicator for missing message and empty message", () => {
    const v = blunderLogView([
      { moveDescription: "X", lineIndex: 2, failingTests: [{ testName: "t" }, { testName: "u", message: "bad" }] },
    ]);
    expect(v.entries[0]!.position).toBe(2);
    expect(v.entries[0]!.failingTests[0]).toMatchObject({ message: EMPTY_MESSAGE_INDICATOR, hasMessage: false });
    expect(v.entries[0]!.failingTests[1]!.message).toBe("bad");
    expect(blunderLogView([]).emptyMessage).not.toBeNull();
  });
  it("formats moves", () => {
    expect(formatMoveEntry({ displayName: "Inline x", annotation: "!!" }, 0)).toBe("1. Inline x !!");
    expect(moveListView([]).emptyMessage).not.toBeNull();
  });
});
