// Feature: refactor-fish, Property 52: Move navigation index logic
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cumulativeDiffSources,
  initialSelection,
  jumpToEndIndex,
  moveDiffSources,
  navigationState,
  nextIndex,
  previousIndex,
} from "./navigation.js";
import type { MoveRecord } from "./types.js";

/** A Best_Line of length L where each move's sourceBefore chains from the previous sourceAfter. */
const arbitraryBestLine = (maxLen = 20) =>
  fc.tuple(fc.string(), fc.array(fc.string(), { maxLength: maxLen })).map(([original, afters]) => {
    const line: MoveRecord[] = [];
    let before = original;
    for (const after of afters) {
      line.push({ displayName: "move", annotation: "!", sourceBefore: before, sourceAfter: after });
      before = after;
    }
    return { original, line };
  });

/** A non-empty Best_Line plus an in-range selection index. */
const arbitraryNonEmptyWithIndex = arbitraryBestLine()
  .filter(({ line }) => line.length > 0)
  .chain((b) => fc.nat({ max: b.line.length - 1 }).map((index) => ({ ...b, index })));

describe("Property 52: Move navigation index logic", () => {
  /** **Validates: Requirements 18.3, 18.4, 18.5, 18.6, 18.7** */
  it("previous/next/jump-to-end select the right index and disable only at the bounds", () => {
    fc.assert(
      fc.property(arbitraryNonEmptyWithIndex, ({ original, line, index }) => {
        const L = line.length;
        const s = navigationState(index, L);

        expect(s.empty).toBe(false);
        expect(s.selectedIndex).toBe(index);
        expect(s.displayIndex).toBe(index + 1);
        expect(s.total).toBe(L);

        // 18.3 / 18.6
        expect(s.previousDisabled).toBe(index === 0);
        expect(previousIndex(index, L)).toBe(index === 0 ? 0 : index - 1);

        // 18.4 / 18.7
        expect(s.nextDisabled).toBe(index === L - 1);
        expect(nextIndex(index, L)).toBe(index === L - 1 ? L - 1 : index + 1);

        // 18.5
        expect(s.jumpToEndDisabled).toBe(false);
        expect(jumpToEndIndex(index, L)).toBe(L - 1);
        expect(cumulativeDiffSources(original, line)).toEqual({
          before: original,
          after: line[L - 1]!.sourceAfter,
        });

        // Selected move's diff uses that move's before/after sources.
        expect(moveDiffSources(line, index)).toEqual({
          before: line[index]!.sourceBefore,
          after: line[index]!.sourceAfter,
        });
        expect(initialSelection(L)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 18.8** */
  it("an empty Best_Line disables all three controls and makes no selection", () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.integer({ min: -5, max: 5 }), { nil: null }), (original, sel) => {
        const s = navigationState(sel, 0);
        expect(s.empty).toBe(true);
        expect(s.selectedIndex).toBeNull();
        expect(s.displayIndex).toBeNull();
        expect(s.previousDisabled).toBe(true);
        expect(s.nextDisabled).toBe(true);
        expect(s.jumpToEndDisabled).toBe(true);
        expect(initialSelection(0)).toBeNull();
        expect(previousIndex(sel, 0)).toBeNull();
        expect(nextIndex(sel, 0)).toBeNull();
        expect(jumpToEndIndex(sel, 0)).toBeNull();
        expect(moveDiffSources([], sel)).toBeNull();
        expect(cumulativeDiffSources(original, [])).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
