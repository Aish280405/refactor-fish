// Feature: refactor-fish, Property 46: Recording parser rejects malformed JSON
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { RecordingParseError, RecordingParser, RecordingPrinter } from "./recording.js";
import { arbitraryRecording } from "../test-utils/index.js";

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** Arbitrary strings that are not valid JSON. */
const notJson: fc.Arbitrary<string> = fc
  .oneof(
    // Free-form text.
    fc.string({ unit: "grapheme", maxLength: 200 }),
    // Strict prefixes of a valid printed Recording (truncated documents).
    arbitraryRecording().chain((r) => {
      const text = RecordingPrinter.print(r);
      return fc.integer({ min: 0, max: text.length - 1 }).map((n) => text.slice(0, n));
    }),
    // A valid printed Recording with a JSON-breaking token spliced in.
    arbitraryRecording().chain((r) => {
      const text = RecordingPrinter.print(r);
      return fc
        .tuple(
          fc.integer({ min: 0, max: text.length }),
          fc.constantFrom("{", "}", "[", "]", ",", ":", "'", "undefined", "NaN", "//", "\u0000"),
        )
        .map(([i, tok]) => text.slice(0, i) + tok + text.slice(i));
    }),
  )
  .filter((s) => !isValidJson(s));

describe("Property 46: Recording parser rejects malformed JSON", () => {
  /** **Validates: Requirements 16.4** */
  it("rejects every non-JSON string with a malformed-json error and no Recording", () => {
    fc.assert(
      fc.property(notJson, (input) => {
        let result: unknown = undefined;
        let error: unknown = undefined;
        try {
          result = RecordingParser.parse(input);
        } catch (e) {
          error = e;
        }
        expect(result).toBeUndefined();
        expect(error).toBeInstanceOf(RecordingParseError);
        const err = error as RecordingParseError;
        expect(err.kind).toBe("malformed-json");
        expect(err.message).toMatch(/malformed JSON/i);
      }),
      { numRuns: 100 },
    );
  });
});
