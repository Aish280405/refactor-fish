// Feature: refactor-fish, Property 50: Recording parser rejects unsupported versions
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  RecordingParseError,
  RecordingParser,
  RecordingPrinter,
  SUPPORTED_RECORDING_VERSIONS,
} from "./recording.js";
import { arbitraryRecording } from "../test-utils/index.js";

/** Integers outside the supported set, covering small values near 1 and the full safe range. */
const unsupportedVersion = fc
  .oneof(fc.integer({ min: -10, max: 10 }), fc.integer(), fc.maxSafeInteger(), fc.maxSafeNat())
  .filter((v) => !SUPPORTED_RECORDING_VERSIONS.includes(v));

describe("Property 50: Recording parser rejects unsupported versions", () => {
  /**
   * For any integer format-version value outside the supported set, the parser rejects
   * the document and reports the version found together with the supported versions.
   *
   * **Validates: Requirements 16.9**
   */
  it("rejects any otherwise-valid Recording whose formatVersion is unsupported", () => {
    fc.assert(
      fc.property(arbitraryRecording(), unsupportedVersion, (recording, version) => {
        const doc = JSON.parse(RecordingPrinter.print(recording)) as Record<string, unknown>;
        doc.formatVersion = version;
        const json = JSON.stringify(doc);

        let error: unknown;
        try {
          RecordingParser.parse(json);
        } catch (e) {
          error = e;
        }

        expect(error).toBeInstanceOf(RecordingParseError);
        const err = error as RecordingParseError;
        expect(err.kind).toBe("unsupported-version");
        expect(err.versionFound).toBe(version);
        expect(err.supportedVersions).toEqual(SUPPORTED_RECORDING_VERSIONS);
        expect(err.message).toContain(String(version));
        for (const v of SUPPORTED_RECORDING_VERSIONS) {
          expect(err.message).toContain(String(v));
        }
      }),
      { numRuns: 100 },
    );
  });
});
