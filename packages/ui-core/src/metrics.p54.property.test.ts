// Feature: refactor-fish, Property 54: Metrics change formatting and mark derivation
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MARK_DISPLAY, changeMark, formatChange, metricRow } from "./metrics.js";

/**
 * **Validates: Requirements 19.4, 19.5**
 */

const metricInt = fc.integer({ min: -1_000_000, max: 1_000_000 });

describe("Property 54: Metrics change formatting and mark derivation", () => {
  it("formats the signed change and derives the mark for any integer pair", () => {
    fc.assert(
      fc.property(metricInt, metricInt, (originalValue, selectedValue) => {
        const delta = selectedValue - originalValue;
        const expectedText = delta === 0 ? "0" : delta > 0 ? `+${delta}` : `-${Math.abs(delta)}`;
        const expectedMark = delta < 0 ? "improved" : delta > 0 ? "worsened" : "unchanged";

        expect(formatChange(delta)).toBe(expectedText);
        expect(changeMark(delta)).toBe(expectedMark);

        const row = metricRow(
          "cyclomaticComplexity",
          { cyclomaticComplexity: originalValue },
          { cyclomaticComplexity: selectedValue },
        );
        expect(row.change).toBe(expectedText);
        expect(row.mark).toBe(expectedMark);
        expect(row.markText).toBe(MARK_DISPLAY[expectedMark].text);
        expect(row.markSymbol).toBe(MARK_DISPLAY[expectedMark].symbol);
      }),
      { numRuns: 100 },
    );
  });
});
