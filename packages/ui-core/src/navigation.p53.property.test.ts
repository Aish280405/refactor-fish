// Feature: refactor-fish, Property 53: For any pair of before/after source strings, the Web_UI SHALL display the "no textual change" message if and only if the two strings are exactly equal.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { hasNoTextualChange } from "./navigation.js";

/**
 * **Validates: Requirements 18.9**
 */

// Source-like text: code characters, whitespace variants, and some non-ASCII.
const sourceChar = fc.constantFrom(
  "a", "b", "x", "1", " ", "\t", "\n", "\r", ";", "{", "}", "(", ")", "=", "\"", "'", "é", "\u00a0", "😀",
);
const sourceText = fc.array(sourceChar, { maxLength: 40 }).map((cs) => cs.join(""));

// A minimal edit of s that always yields a different string.
const nearbyPair = sourceText.chain((s) =>
  fc
    .oneof(
      // insert one char
      fc.tuple(fc.nat({ max: s.length }), sourceChar).map(([i, c]) => s.slice(0, i) + c + s.slice(i)),
      // append trailing newline / whitespace
      fc.constantFrom("\n", " ", "\r\n").map((w) => s + w),
      // delete one char (only when non-empty)
      ...(s.length > 0 ? [fc.nat({ max: s.length - 1 }).map((i) => s.slice(0, i) + s.slice(i + 1))] : []),
    )
    .filter((t) => t !== s)
    .map((t) => [s, t] as const),
);

describe("Property 53: No-textual-change detection", () => {
  it("reports no textual change for identical strings (including copies)", () => {
    fc.assert(
      fc.property(sourceText, (s) => {
        // Build an independent copy so the check is not reference-based.
        const copy = s.split("").join("");
        expect(hasNoTextualChange(s, copy)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("reports a change for strings that differ by a single edit", () => {
    fc.assert(
      fc.property(nearbyPair, ([before, after]) => {
        expect(hasNoTextualChange(before, after)).toBe(false);
        expect(hasNoTextualChange(after, before)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("is true iff the strings are exactly equal, for arbitrary pairs", () => {
    fc.assert(
      fc.property(fc.oneof(fc.tuple(sourceText, sourceText), fc.tuple(fc.string(), fc.string())), ([before, after]) => {
        expect(hasNoTextualChange(before, after)).toBe(before === after);
      }),
      { numRuns: 100 },
    );
  });
});
