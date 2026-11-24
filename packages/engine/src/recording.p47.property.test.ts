// Feature: refactor-fish, Property 47: Recording parser reports first missing required field
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbitraryRecording } from "../test-utils/index.js";
import { RecordingParseError, RecordingParser } from "./recording.js";

/** Required top-level fields in the order of Requirement 16 criterion 1 (design.md Recording). */
const FIELD_ORDER = [
  "formatVersion",
  "targetFileName",
  "originalSource",
  "originalMetrics",
  "originalScore",
  "searchSettings",
  "coverage",
  "allLines",
  "bestLine",
  "blunders",
  "progressEvents",
] as const;

function parseError(json: string): RecordingParseError {
  try {
    RecordingParser.parse(json);
  } catch (e) {
    if (e instanceof RecordingParseError) return e;
    throw e;
  }
  throw new Error("parser accepted a Recording with missing fields");
}

function withoutFields(recording: object, removed: readonly string[]): string {
  const doc: Record<string, unknown> = { ...recording };
  for (const key of removed) delete doc[key];
  return JSON.stringify(doc);
}

describe("Property 47: Recording parser reports first missing required field", () => {
  /** **Validates: Requirements 16.5** */
  it("names the single removed field", () => {
    fc.assert(
      fc.property(arbitraryRecording(), fc.constantFrom(...FIELD_ORDER), (recording, removed) => {
        const err = parseError(withoutFields(recording, [removed]));
        expect(err.kind).toBe("missing-field");
        expect(err.field).toBe(removed);
        expect(err.message).toContain(removed);
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 16.5** */
  it("names the earliest removed field in design order when several are removed", () => {
    fc.assert(
      fc.property(
        arbitraryRecording(),
        fc.shuffledSubarray([...FIELD_ORDER], { minLength: 2 }),
        (recording, removed) => {
          const expected = FIELD_ORDER.find((f) => removed.includes(f));
          const err = parseError(withoutFields(recording, removed));
          expect(err.kind).toBe("missing-field");
          expect(err.field).toBe(expected);
          expect(err.message).toContain(`"${expected}"`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
