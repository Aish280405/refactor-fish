// Feature: refactor-fish, Property 49: For at least 100 generated valid Recordings, including ones with zero Blunders and an empty Best_Line, parsing, then printing, then parsing again SHALL produce a Recording equal in every field to the first parsed Recording.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { RecordingParser, RecordingPrinter } from "./recording.js";
import { arbitraryRecording } from "../test-utils/index.js";

/**
 * **Validates: Requirements 16.7, 16.8, 24.5**
 */
describe("Property 49: Recording round-trip", () => {
  // Mix general Recordings with the required edge cases (zero Blunders, empty Best_Line, both).
  const recordings = fc.oneof(
    arbitraryRecording(),
    arbitraryRecording({ noBlunders: true }),
    arbitraryRecording({ emptyBestLine: true }),
    arbitraryRecording({ noBlunders: true, emptyBestLine: true }),
  );

  it("parse -> print -> parse yields a Recording equal to the first parse", () => {
    fc.assert(
      fc.property(recordings, (recording) => {
        const first = RecordingParser.parse(JSON.stringify(recording));
        const second = RecordingParser.parse(RecordingPrinter.print(first));
        expect(second).toStrictEqual(first);
      }),
      { numRuns: 200 },
    );
  });

  it("covers zero Blunders and an empty Best_Line explicitly", () => {
    fc.assert(
      fc.property(arbitraryRecording({ noBlunders: true, emptyBestLine: true }), (recording) => {
        const first = RecordingParser.parse(JSON.stringify(recording));
        expect(first.blunders).toEqual([]);
        expect(first.bestLine).toEqual([]);
        const second = RecordingParser.parse(RecordingPrinter.print(first));
        expect(second).toStrictEqual(first);
      }),
      { numRuns: 100 },
    );
  });
});
