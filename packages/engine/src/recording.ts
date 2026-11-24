import type { Annotation, Metrics, MoveKind, TestFailure } from "./types.js";

export interface MoveRecord {
  index: number;
  kind: MoveKind;
  displayName: string;
  description: string;
  annotation: Annotation;
  sourceBefore: string;
  sourceAfter: string;
  metricsBefore: Metrics;
  metricsAfter: Metrics;
  scoreBefore: number;
  scoreAfter: number;
}

export interface BlunderRecord {
  moveDescription: string;
  lineIndex: number;
  failingTests: TestFailure[];
  failureReason?: "timeout" | "test execution error";
}

export interface LineRecord {
  moves: MoveRecord[];
  finalScore: number;
}

export interface CoverageInfo {
  percent: number | null;
  unknown: boolean;
  belowThreshold: boolean;
}

export interface SearchSettings {
  searchDepth: 3 | 4;
  beamWidth: number;
  llmEnabled: boolean;
}

export interface ProgressEventRecord {
  score: number;
  line: MoveRecord[];
  depth: number;
  positionsTested: number;
}

/** Field order matches design.md; the parser checks missing fields in this order. */
export interface Recording {
  formatVersion: 1;
  targetFileName: string;
  originalSource: string;
  originalMetrics: Metrics;
  originalScore: number;
  searchSettings: SearchSettings;
  coverage: CoverageInfo;
  allLines: LineRecord[];
  bestLine: MoveRecord[];
  blunders: BlunderRecord[];
  progressEvents: ProgressEventRecord[];
}

export const SUPPORTED_RECORDING_VERSIONS: readonly number[] = [1];

export type RecordingParseErrorKind =
  | "malformed-json"
  | "missing-field"
  | "wrong-type"
  | "unsupported-version";

export class RecordingParseError extends Error {
  readonly kind: RecordingParseErrorKind;
  /** Field path (e.g. "allLines[0].moves[1].kind") for missing-field / wrong-type / unsupported-version. */
  readonly field?: string;
  /** Expected type description for wrong-type errors. */
  readonly expectedType?: string;
  /** Version found, for unsupported-version errors. */
  readonly versionFound?: unknown;
  /** Supported versions, for unsupported-version errors. */
  readonly supportedVersions?: readonly number[];

  constructor(
    kind: RecordingParseErrorKind,
    message: string,
    details: {
      field?: string;
      expectedType?: string;
      versionFound?: unknown;
      supportedVersions?: readonly number[];
    } = {},
  ) {
    super(message);
    this.name = "RecordingParseError";
    this.kind = kind;
    this.field = details.field;
    this.expectedType = details.expectedType;
    this.versionFound = details.versionFound;
    this.supportedVersions = details.supportedVersions;
  }
}

const MOVE_KINDS: readonly MoveKind[] = [
  "RemoveUnused",
  "InlineVariable",
  "GuardClause",
  "SimplifyBoolean",
  "ExtractFunction",
  "LLMMove",
];
const ANNOTATIONS: readonly Annotation[] = ["!!", "!", "?!", "??"];
const FAILURE_REASONS = ["timeout", "test execution error"] as const;

const TOP_LEVEL_FIELDS = [
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

type Obj = Record<string, unknown>;

function missing(path: string): never {
  throw new RecordingParseError("missing-field", `Recording is missing required field "${path}"`, {
    field: path,
  });
}

function wrongType(path: string, expected: string): never {
  throw new RecordingParseError(
    "wrong-type",
    `Recording field "${path}" has the wrong type; expected ${expected}`,
    { field: path, expectedType: expected },
  );
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function reqObj(v: unknown, path: string): Obj {
  if (!isObj(v)) wrongType(path, "object");
  return v;
}

function field(o: Obj, key: string, path: string): unknown {
  if (!(key in o) || o[key] === undefined) missing(join(path, key));
  return o[key];
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") wrongType(path, "string");
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) wrongType(path, "number");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") wrongType(path, "boolean");
  return v;
}

function int(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) wrongType(path, "integer");
  return v;
}

function arr<T>(v: unknown, path: string, each: (item: unknown, p: string) => T): T[] {
  if (!Array.isArray(v)) wrongType(path, "array");
  return v.map((item, i) => each(item, `${path}[${i}]`));
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    wrongType(path, `one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  return v as T;
}

function parseMetrics(v: unknown, path: string): Metrics {
  const o = reqObj(v, path);
  const cyclomaticComplexity = num(field(o, "cyclomaticComplexity", path), join(path, "cyclomaticComplexity"));
  const maxNestingDepth = num(field(o, "maxNestingDepth", path), join(path, "maxNestingDepth"));
  const functionLength = num(field(o, "functionLength", path), join(path, "functionLength"));
  const duplicatedCode = num(field(o, "duplicatedCode", path), join(path, "duplicatedCode"));
  const unusedCode = num(field(o, "unusedCode", path), join(path, "unusedCode"));
  return { cyclomaticComplexity, maxNestingDepth, functionLength, duplicatedCode, unusedCode };
}

function parseMove(v: unknown, path: string): MoveRecord {
  const o = reqObj(v, path);
  const p = (k: string) => join(path, k);
  const index = int(field(o, "index", path), p("index"));
  const kind = oneOf(field(o, "kind", path), p("kind"), MOVE_KINDS);
  const displayName = str(field(o, "displayName", path), p("displayName"));
  const description = str(field(o, "description", path), p("description"));
  const annotation = oneOf(field(o, "annotation", path), p("annotation"), ANNOTATIONS);
  const sourceBefore = str(field(o, "sourceBefore", path), p("sourceBefore"));
  const sourceAfter = str(field(o, "sourceAfter", path), p("sourceAfter"));
  const metricsBefore = parseMetrics(field(o, "metricsBefore", path), p("metricsBefore"));
  const metricsAfter = parseMetrics(field(o, "metricsAfter", path), p("metricsAfter"));
  const scoreBefore = num(field(o, "scoreBefore", path), p("scoreBefore"));
  const scoreAfter = num(field(o, "scoreAfter", path), p("scoreAfter"));
  return {
    index,
    kind,
    displayName,
    description,
    annotation,
    sourceBefore,
    sourceAfter,
    metricsBefore,
    metricsAfter,
    scoreBefore,
    scoreAfter,
  };
}

function parseTestFailure(v: unknown, path: string): TestFailure {
  const o = reqObj(v, path);
  const testName = str(field(o, "testName", path), join(path, "testName"));
  const out: TestFailure = { testName };
  if (o.message !== undefined) out.message = str(o.message, join(path, "message"));
  return out;
}

function parseBlunder(v: unknown, path: string): BlunderRecord {
  const o = reqObj(v, path);
  const p = (k: string) => join(path, k);
  const moveDescription = str(field(o, "moveDescription", path), p("moveDescription"));
  const lineIndex = int(field(o, "lineIndex", path), p("lineIndex"));
  const failingTests = arr(field(o, "failingTests", path), p("failingTests"), parseTestFailure);
  const out: BlunderRecord = { moveDescription, lineIndex, failingTests };
  if (o.failureReason !== undefined) {
    out.failureReason = oneOf(o.failureReason, p("failureReason"), FAILURE_REASONS);
  }
  return out;
}

function parseLine(v: unknown, path: string): LineRecord {
  const o = reqObj(v, path);
  const moves = arr(field(o, "moves", path), join(path, "moves"), parseMove);
  const finalScore = num(field(o, "finalScore", path), join(path, "finalScore"));
  return { moves, finalScore };
}

function parseProgressEvent(v: unknown, path: string): ProgressEventRecord {
  const o = reqObj(v, path);
  const p = (k: string) => join(path, k);
  const score = num(field(o, "score", path), p("score"));
  const line = arr(field(o, "line", path), p("line"), parseMove);
  const depth = num(field(o, "depth", path), p("depth"));
  const positionsTested = num(field(o, "positionsTested", path), p("positionsTested"));
  return { score, line, depth, positionsTested };
}

function parseSettings(v: unknown, path: string): SearchSettings {
  const o = reqObj(v, path);
  const p = (k: string) => join(path, k);
  const depth = num(field(o, "searchDepth", path), p("searchDepth"));
  if (depth !== 3 && depth !== 4) wrongType(p("searchDepth"), "3 or 4");
  const beamWidth = num(field(o, "beamWidth", path), p("beamWidth"));
  const llmEnabled = bool(field(o, "llmEnabled", path), p("llmEnabled"));
  return { searchDepth: depth, beamWidth, llmEnabled };
}

function parseCoverage(v: unknown, path: string): CoverageInfo {
  const o = reqObj(v, path);
  const p = (k: string) => join(path, k);
  const rawPercent = field(o, "percent", path);
  const percent = rawPercent === null ? null : num(rawPercent, p("percent"));
  const unknown = bool(field(o, "unknown", path), p("unknown"));
  const belowThreshold = bool(field(o, "belowThreshold", path), p("belowThreshold"));
  return { percent, unknown, belowThreshold };
}

export const RecordingParser = {
  /**
   * Validation order: JSON syntax, missing field (design field order), wrong type,
   * supported version. Throws RecordingParseError; never returns a partial Recording.
   */
  parse(json: string): Recording {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new RecordingParseError(
        "malformed-json",
        `Recording is malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!isObj(raw)) wrongType("(root)", "object");

    // 1. Missing fields, in design order.
    for (const key of TOP_LEVEL_FIELDS) {
      if (!(key in raw) || raw[key] === undefined) missing(key);
    }

    // 2. Types (including nested structure), in design order.
    const version = int(raw.formatVersion, "formatVersion");
    const targetFileName = str(raw.targetFileName, "targetFileName");
    const originalSource = str(raw.originalSource, "originalSource");
    const originalMetrics = parseMetrics(raw.originalMetrics, "originalMetrics");
    const originalScore = num(raw.originalScore, "originalScore");
    const searchSettings = parseSettings(raw.searchSettings, "searchSettings");
    const coverage = parseCoverage(raw.coverage, "coverage");
    const allLines = arr(raw.allLines, "allLines", parseLine);
    const bestLine = arr(raw.bestLine, "bestLine", parseMove);
    const blunders = arr(raw.blunders, "blunders", parseBlunder);
    const progressEvents = arr(raw.progressEvents, "progressEvents", parseProgressEvent);

    // 3. Supported version.
    if (!SUPPORTED_RECORDING_VERSIONS.includes(version)) {
      throw new RecordingParseError(
        "unsupported-version",
        `Unsupported Recording format version ${version}; supported versions: ${SUPPORTED_RECORDING_VERSIONS.join(", ")}`,
        {
          field: "formatVersion",
          versionFound: version,
          supportedVersions: SUPPORTED_RECORDING_VERSIONS,
        },
      );
    }

    return {
      formatVersion: 1,
      targetFileName,
      originalSource,
      originalMetrics,
      originalScore,
      searchSettings,
      coverage,
      allLines,
      bestLine,
      blunders,
      progressEvents,
    };
  },
};

function orderMetrics(m: Metrics): Metrics {
  return {
    cyclomaticComplexity: m.cyclomaticComplexity,
    maxNestingDepth: m.maxNestingDepth,
    functionLength: m.functionLength,
    duplicatedCode: m.duplicatedCode,
    unusedCode: m.unusedCode,
  };
}

function orderMove(m: MoveRecord): MoveRecord {
  return {
    index: m.index,
    kind: m.kind,
    displayName: m.displayName,
    description: m.description,
    annotation: m.annotation,
    sourceBefore: m.sourceBefore,
    sourceAfter: m.sourceAfter,
    metricsBefore: orderMetrics(m.metricsBefore),
    metricsAfter: orderMetrics(m.metricsAfter),
    scoreBefore: m.scoreBefore,
    scoreAfter: m.scoreAfter,
  };
}

function orderBlunder(b: BlunderRecord): BlunderRecord {
  const out: BlunderRecord = {
    moveDescription: b.moveDescription,
    lineIndex: b.lineIndex,
    failingTests: b.failingTests.map((t) => {
      const f: TestFailure = { testName: t.testName };
      if (t.message !== undefined) f.message = t.message;
      return f;
    }),
  };
  if (b.failureReason !== undefined) out.failureReason = b.failureReason;
  return out;
}

export const RecordingPrinter = {
  /** Serializes with a stable key order and `formatVersion: 1`. */
  print(recording: Recording): string {
    const ordered: Recording = {
      formatVersion: 1,
      targetFileName: recording.targetFileName,
      originalSource: recording.originalSource,
      originalMetrics: orderMetrics(recording.originalMetrics),
      originalScore: recording.originalScore,
      searchSettings: {
        searchDepth: recording.searchSettings.searchDepth,
        beamWidth: recording.searchSettings.beamWidth,
        llmEnabled: recording.searchSettings.llmEnabled,
      },
      coverage: {
        percent: recording.coverage.percent,
        unknown: recording.coverage.unknown,
        belowThreshold: recording.coverage.belowThreshold,
      },
      allLines: recording.allLines.map((l) => ({
        moves: l.moves.map(orderMove),
        finalScore: l.finalScore,
      })),
      bestLine: recording.bestLine.map(orderMove),
      blunders: recording.blunders.map(orderBlunder),
      progressEvents: recording.progressEvents.map((e) => ({
        score: e.score,
        line: e.line.map(orderMove),
        depth: e.depth,
        positionsTested: e.positionsTested,
      })),
    };
    return JSON.stringify(ordered, null, 2);
  },
};
