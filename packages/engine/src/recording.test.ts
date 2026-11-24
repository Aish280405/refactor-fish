import { describe, expect, it } from "vitest";
import {
  RecordingParseError,
  RecordingParser,
  RecordingPrinter,
  type Recording,
} from "./recording.js";

const metrics = {
  cyclomaticComplexity: 1,
  maxNestingDepth: 2,
  functionLength: 3,
  duplicatedCode: 4,
  unusedCode: 5,
};

const move = {
  index: 1,
  kind: "GuardClause" as const,
  displayName: "Guard clause",
  description: "d",
  annotation: "!" as const,
  sourceBefore: "a",
  sourceAfter: "b",
  metricsBefore: metrics,
  metricsAfter: metrics,
  scoreBefore: -2,
  scoreAfter: -1,
};

const sample: Recording = {
  formatVersion: 1,
  targetFileName: "x.ts",
  originalSource: "a",
  originalMetrics: metrics,
  originalScore: -2,
  searchSettings: { searchDepth: 3, beamWidth: 3, llmEnabled: false },
  coverage: { percent: null, unknown: true, belowThreshold: false },
  allLines: [{ moves: [move], finalScore: -1.5 }],
  bestLine: [move],
  blunders: [
    { moveDescription: "m", lineIndex: 1, failingTests: [{ testName: "t", message: "x" }], failureReason: "timeout" },
  ],
  progressEvents: [{ score: -1.5, line: [move], depth: 1, positionsTested: 2 }],
};

function expectError(json: string, kind: string): RecordingParseError {
  try {
    RecordingParser.parse(json);
  } catch (e) {
    expect(e).toBeInstanceOf(RecordingParseError);
    expect((e as RecordingParseError).kind).toBe(kind);
    return e as RecordingParseError;
  }
  throw new Error("expected parse to throw");
}

describe("Recording parser/printer", () => {
  it("round-trips", () => {
    const parsed = RecordingParser.parse(RecordingPrinter.print(sample));
    expect(parsed).toEqual(sample);
    expect(RecordingPrinter.print(parsed)).toBe(RecordingPrinter.print(sample));
  });

  it("prints keys in design order with formatVersion first", () => {
    const shuffled = Object.fromEntries(Object.entries(sample).reverse()) as unknown as Recording;
    expect(Object.keys(JSON.parse(RecordingPrinter.print(shuffled)))).toEqual(Object.keys(sample));
  });

  it("rejects malformed JSON", () => {
    expectError("{nope", "malformed-json");
  });

  it("names the first missing field in design order", () => {
    const { originalScore: _a, coverage: _b, ...rest } = sample;
    const e = expectError(JSON.stringify(rest), "missing-field");
    expect(e.field).toBe("originalScore");
  });

  it("reports missing before wrong type", () => {
    const bad = { ...sample, targetFileName: 5 } as Record<string, unknown>;
    delete bad.progressEvents;
    expect(expectError(JSON.stringify(bad), "missing-field").field).toBe("progressEvents");
  });

  it("reports wrong type with field and expected type", () => {
    const e = expectError(JSON.stringify({ ...sample, originalScore: "1" }), "wrong-type");
    expect(e.field).toBe("originalScore");
    expect(e.expectedType).toBe("number");
  });

  it("reports nested wrong type", () => {
    const bad = { ...sample, bestLine: [{ ...move, annotation: "x" }] };
    expect(expectError(JSON.stringify(bad), "wrong-type").field).toBe("bestLine[0].annotation");
  });

  it("rejects unsupported version after type checks", () => {
    const e = expectError(JSON.stringify({ ...sample, formatVersion: 2 }), "unsupported-version");
    expect(e.versionFound).toBe(2);
    expect(e.supportedVersions).toEqual([1]);
    expect(e.message).toContain("2");
  });

  it("type errors win over unsupported version", () => {
    expectError(JSON.stringify({ ...sample, formatVersion: 2, originalScore: "x" }), "wrong-type");
  });
});
