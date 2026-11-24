// Feature: refactor-fish, Property 48: Recording parser reports wrong-type fields
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbitraryRecording, type Recording } from "../test-utils/index.js";
import { RecordingParseError, RecordingParser } from "./recording.js";

/** Declared type of a required Recording field, as seen in the JSON document. */
type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "enum"
  | "nullable-number"
  | "depth";

type PathSegment = string | number;

interface Target {
  path: PathSegment[];
  kind: FieldKind;
}

/** JSON values whose type is incompatible with each declared field type. */
const INCOMPATIBLE: Record<FieldKind, unknown[]> = {
  string: [42, true, null, [], {}],
  number: ["7", true, null, [], {}],
  integer: ["1", 1.5, true, null, [], {}],
  boolean: [0, "true", null, [], {}],
  object: ["x", 3, true, null, []],
  array: ["x", 3, true, null, {}],
  enum: [3, true, null, [], {}],
  "nullable-number": ["7", true, [], {}],
  depth: ["4", true, null, [], {}],
};

const METRIC_KEYS = [
  "cyclomaticComplexity",
  "maxNestingDepth",
  "functionLength",
  "duplicatedCode",
  "unusedCode",
] as const;

function metricsTargets(base: PathSegment[]): Target[] {
  return [{ path: base, kind: "object" }, ...METRIC_KEYS.map((k) => ({ path: [...base, k], kind: "number" as const }))];
}

function moveTargets(base: PathSegment[]): Target[] {
  const p = (k: string): PathSegment[] => [...base, k];
  return [
    { path: p("index"), kind: "integer" },
    { path: p("kind"), kind: "enum" },
    { path: p("displayName"), kind: "string" },
    { path: p("description"), kind: "string" },
    { path: p("annotation"), kind: "enum" },
    { path: p("sourceBefore"), kind: "string" },
    { path: p("sourceAfter"), kind: "string" },
    ...metricsTargets(p("metricsBefore")),
    ...metricsTargets(p("metricsAfter")),
    { path: p("scoreBefore"), kind: "number" },
    { path: p("scoreAfter"), kind: "number" },
  ];
}

function movesTargets(base: PathSegment[], count: number): Target[] {
  const out: Target[] = [{ path: base, kind: "array" }];
  for (let i = 0; i < count; i++) out.push(...moveTargets([...base, i]));
  return out;
}

/** Every required field (top-level and nested) present in the given Recording. */
function requiredFieldTargets(rec: Recording): Target[] {
  const out: Target[] = [
    { path: ["formatVersion"], kind: "integer" },
    { path: ["targetFileName"], kind: "string" },
    { path: ["originalSource"], kind: "string" },
    ...metricsTargets(["originalMetrics"]),
    { path: ["originalScore"], kind: "number" },
    { path: ["searchSettings"], kind: "object" },
    { path: ["searchSettings", "searchDepth"], kind: "depth" },
    { path: ["searchSettings", "beamWidth"], kind: "number" },
    { path: ["searchSettings", "llmEnabled"], kind: "boolean" },
    { path: ["coverage"], kind: "object" },
    { path: ["coverage", "percent"], kind: "nullable-number" },
    { path: ["coverage", "unknown"], kind: "boolean" },
    { path: ["coverage", "belowThreshold"], kind: "boolean" },
    { path: ["allLines"], kind: "array" },
  ];
  rec.allLines.forEach((line, i) => {
    out.push(...movesTargets(["allLines", i, "moves"], line.moves.length));
    out.push({ path: ["allLines", i, "finalScore"], kind: "number" });
  });
  out.push(...movesTargets(["bestLine"], rec.bestLine.length));
  out.push({ path: ["blunders"], kind: "array" });
  rec.blunders.forEach((b, i) => {
    out.push({ path: ["blunders", i, "moveDescription"], kind: "string" });
    out.push({ path: ["blunders", i, "lineIndex"], kind: "integer" });
    out.push({ path: ["blunders", i, "failingTests"], kind: "array" });
    b.failingTests.forEach((_, j) => {
      out.push({ path: ["blunders", i, "failingTests", j, "testName"], kind: "string" });
    });
  });
  out.push({ path: ["progressEvents"], kind: "array" });
  rec.progressEvents.forEach((e, i) => {
    out.push({ path: ["progressEvents", i, "score"], kind: "number" });
    out.push(...movesTargets(["progressEvents", i, "line"], e.line.length));
    out.push({ path: ["progressEvents", i, "depth"], kind: "number" });
    out.push({ path: ["progressEvents", i, "positionsTested"], kind: "number" });
  });
  return out;
}

/** Formats a path the way the parser names fields, e.g. "allLines[0].moves[1].kind". */
function formatPath(path: PathSegment[]): string {
  let s = "";
  for (const seg of path) {
    if (typeof seg === "number") s += `[${seg}]`;
    else s += s === "" ? seg : `.${seg}`;
  }
  return s;
}

function getAt(doc: unknown, path: PathSegment[]): unknown {
  let cur: any = doc;
  for (const seg of path) cur = cur[seg];
  return cur;
}

function setAt(doc: unknown, path: PathSegment[], value: unknown): void {
  const parent: any = getAt(doc, path.slice(0, -1));
  parent[path[path.length - 1]!] = value;
}

/** Whether `v` satisfies an expected-type description reported by the parser. */
function conforms(v: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "3 or 4":
      return v === 3 || v === 4;
  }
  if (expectedType.startsWith("one of ")) {
    const allowed: unknown[] = JSON.parse(`[${expectedType.slice("one of ".length)}]`);
    return allowed.includes(v);
  }
  throw new Error(`Unrecognized expected type description: ${expectedType}`);
}

const arbitraryWrongTypeCase = arbitraryRecording().chain((rec) =>
  fc.constantFrom(...requiredFieldTargets(rec)).chain((target) =>
    fc.constantFrom(...INCOMPATIBLE[target.kind]).map((replacement) => ({ rec, target, replacement })),
  ),
);

describe("Property 48: Recording parser reports wrong-type fields", () => {
  /** **Validates: Requirements 16.6** */
  it("rejects a document with one required field of the wrong type, naming the field and its expected type", () => {
    fc.assert(
      fc.property(arbitraryWrongTypeCase, ({ rec, target, replacement }) => {
        const doc: unknown = JSON.parse(JSON.stringify(rec));
        const original = getAt(doc, target.path);
        setAt(doc, target.path, replacement);
        const fieldName = formatPath(target.path);

        let error: unknown;
        let result: unknown;
        try {
          result = RecordingParser.parse(JSON.stringify(doc));
        } catch (e) {
          error = e;
        }

        expect(result).toBeUndefined();
        expect(error).toBeInstanceOf(RecordingParseError);
        const err = error as RecordingParseError;
        expect(err.kind).toBe("wrong-type");
        expect(err.field).toBe(fieldName);
        expect(typeof err.expectedType).toBe("string");
        const expectedType = err.expectedType!;
        // The reported type describes the original value but not the replacement.
        if (original !== null) expect(conforms(original, expectedType)).toBe(true);
        expect(conforms(replacement, expectedType)).toBe(false);
        expect(err.message).toContain(fieldName);
        expect(err.message).toContain(expectedType);
      }),
      { numRuns: 100 },
    );
  });
});
