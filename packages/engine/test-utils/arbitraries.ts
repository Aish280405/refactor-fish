import fc from "fast-check";
import type {
  Annotation,
  BlunderRecord,
  CoverageInfo,
  LineRecord,
  Metrics,
  MoveKind,
  MoveRecord,
  Position,
  ProgressEventRecord,
  Recording,
  SearchSettings,
  TestFailure,
  TestOutcome,
} from "./types.js";

/** One-decimal number in [-100, 100], JSON-safe (no NaN, Infinity or -0). */
const arbitraryScore = (): fc.Arbitrary<number> =>
  fc.integer({ min: -1000, max: 1000 }).map((n) => (n === 0 ? 0 : n / 10));

const arbitraryText = (): fc.Arbitrary<string> => fc.string({ maxLength: 40 });

const MOVE_KINDS: MoveKind[] = [
  "RemoveUnused",
  "InlineVariable",
  "GuardClause",
  "SimplifyBoolean",
  "ExtractFunction",
  "LLMMove",
];
const ANNOTATIONS: Annotation[] = ["!!", "!", "?!", "??"];

export function arbitraryMetrics(): fc.Arbitrary<Metrics> {
  return fc.record({
    cyclomaticComplexity: fc.integer({ min: 0, max: 200 }),
    maxNestingDepth: fc.integer({ min: 0, max: 20 }),
    functionLength: fc.integer({ min: 0, max: 1000 }),
    duplicatedCode: fc.integer({ min: 0, max: 200 }),
    unusedCode: fc.integer({ min: 0, max: 100 }),
  });
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface PositionShape {
  /** Declarations that are neither exported nor referenced. */
  unusedDeclarations: number;
  /** `const` declarations referenced exactly once, at the next statement. */
  singleUseConsts: number;
  /** Functions containing an `if` without `else` followed by a `return`. */
  nestedIfs: number;
  /** Functions with a `boolean`-typed `x === true` comparison. */
  booleanExpressions: number;
  /** When set, adds a function with a block of this many statements (>= 5). */
  longBlockLength: number | undefined;
}

export interface ArbitraryPositionOptions {
  maxUnusedDeclarations?: number;
  maxSingleUseConsts?: number;
  maxNestedIfs?: number;
  maxBooleanExpressions?: number;
  /** Probability-free switch: always include a 5+-statement block. */
  alwaysLongBlock?: boolean;
}

/** Builds syntactically valid, type-correct TypeScript from a shape. Deterministic in `shape`. */
export function buildSource(shape: PositionShape): string {
  const out: string[] = [];
  for (let i = 0; i < shape.unusedDeclarations; i++) {
    out.push(i % 2 === 0 ? `const unused${i} = ${i};` : `function unusedFn${i}(): number { return ${i}; }`);
  }
  for (let i = 0; i < shape.singleUseConsts; i++) {
    out.push(`export function single${i}(a: number): number {\n  const t${i} = a + ${i};\n  return t${i} * 2;\n}`);
  }
  for (let i = 0; i < shape.nestedIfs; i++) {
    out.push(
      `export function guard${i}(v: number): number {\n  if (v > ${i}) {\n    v = v + 1;\n    v = v * 2;\n  }\n  return v;\n}`,
    );
  }
  for (let i = 0; i < shape.booleanExpressions; i++) {
    out.push(`export function flag${i}(b: boolean): number {\n  if (b === true) { return ${i}; }\n  return -1;\n}`);
  }
  if (shape.longBlockLength !== undefined) {
    const body: string[] = ["  let acc = seed;"];
    for (let i = 1; i < shape.longBlockLength; i++) body.push(`  acc = acc + ${i};`);
    out.push(`export function longBlock(seed: number): number {\n${body.join("\n")}\n  return acc;\n}`);
  }
  if (out.length === 0) out.push("export const empty = 0;");
  return out.join("\n\n") + "\n";
}

export function arbitraryPositionShape(options: ArbitraryPositionOptions = {}): fc.Arbitrary<PositionShape> {
  return fc.record({
    unusedDeclarations: fc.integer({ min: 0, max: options.maxUnusedDeclarations ?? 3 }),
    singleUseConsts: fc.integer({ min: 0, max: options.maxSingleUseConsts ?? 3 }),
    nestedIfs: fc.integer({ min: 0, max: options.maxNestedIfs ?? 3 }),
    booleanExpressions: fc.integer({ min: 0, max: options.maxBooleanExpressions ?? 3 }),
    longBlockLength: options.alwaysLongBlock
      ? fc.integer({ min: 5, max: 9 })
      : fc.option(fc.integer({ min: 5, max: 9 }), { nil: undefined }),
  });
}

export function arbitraryPosition(options: ArbitraryPositionOptions = {}): fc.Arbitrary<Position> {
  return arbitraryPositionShape(options).map((shape) => ({ sourceText: buildSource(shape), filePath: "target.ts" }));
}

// ---------------------------------------------------------------------------
// TestOutcome
// ---------------------------------------------------------------------------

export function arbitraryTestFailure(): fc.Arbitrary<TestFailure> {
  return fc.record(
    { testName: fc.string({ minLength: 1, maxLength: 30 }), message: arbitraryText() },
    { requiredKeys: ["testName"] },
  );
}

export function arbitraryTestOutcome(): fc.Arbitrary<TestOutcome> {
  return fc.oneof(
    fc.constant<TestOutcome>({ kind: "passed" }),
    fc.array(arbitraryTestFailure(), { minLength: 1, maxLength: 4 }).map<TestOutcome>((failures) => ({
      kind: "failed",
      failures,
    })),
    arbitraryText().map<TestOutcome>((message) => ({ kind: "error", message })),
    fc.constant<TestOutcome>({ kind: "timeout" }),
  );
}

// ---------------------------------------------------------------------------
// Lines and Recordings
// ---------------------------------------------------------------------------

function arbitraryMoveRecordBase(): fc.Arbitrary<MoveRecord> {
  return fc.record({
    index: fc.constant(1),
    kind: fc.constantFrom(...MOVE_KINDS),
    displayName: arbitraryText(),
    description: arbitraryText(),
    annotation: fc.constantFrom(...ANNOTATIONS),
    sourceBefore: arbitraryText(),
    sourceAfter: arbitraryText(),
    metricsBefore: arbitraryMetrics(),
    metricsAfter: arbitraryMetrics(),
    scoreBefore: arbitraryScore(),
    scoreAfter: arbitraryScore(),
  });
}

/** Re-indexes moves 1..n and chains before/after fields so the Line is internally consistent. */
function chain(moves: MoveRecord[]): MoveRecord[] {
  return moves.map((m, i) => {
    const prev = i > 0 ? moves[i - 1]! : undefined;
    return {
      ...m,
      index: i + 1,
      sourceBefore: prev ? prev.sourceAfter : m.sourceBefore,
      metricsBefore: prev ? prev.metricsAfter : m.metricsBefore,
      scoreBefore: prev ? prev.scoreAfter : m.scoreBefore,
    };
  });
}

export function arbitraryMoveRecords(maxLength = 4): fc.Arbitrary<MoveRecord[]> {
  return fc.array(arbitraryMoveRecordBase(), { maxLength }).map(chain);
}

/** A LineRecord with 0..maxMoves chained Moves. */
export function arbitraryLine(maxMoves = 4): fc.Arbitrary<LineRecord> {
  return fc.record({ moves: arbitraryMoveRecords(maxMoves), finalScore: arbitraryScore() });
}

function arbitraryBlunder(): fc.Arbitrary<BlunderRecord> {
  return fc.record(
    {
      moveDescription: arbitraryText(),
      lineIndex: fc.integer({ min: 1, max: 4 }),
      failingTests: fc.array(arbitraryTestFailure(), { maxLength: 3 }),
      failureReason: fc.constantFrom<"timeout" | "test execution error">("timeout", "test execution error"),
    },
    { requiredKeys: ["moveDescription", "lineIndex", "failingTests"] },
  );
}

function arbitraryCoverage(): fc.Arbitrary<CoverageInfo> {
  return fc.oneof(
    fc.constant<CoverageInfo>({ percent: null, unknown: true, belowThreshold: false }),
    fc.integer({ min: 0, max: 1000 }).map<CoverageInfo>((n) => ({
      percent: n / 10,
      unknown: false,
      belowThreshold: n / 10 < 60,
    })),
  );
}

function arbitrarySettings(): fc.Arbitrary<SearchSettings> {
  return fc.record({
    searchDepth: fc.constantFrom<3 | 4>(3, 4),
    beamWidth: fc.integer({ min: 1, max: 6 }),
    llmEnabled: fc.boolean(),
  });
}

function arbitraryProgressEvent(): fc.Arbitrary<ProgressEventRecord> {
  return fc.record({
    score: arbitraryScore(),
    line: arbitraryMoveRecords(3),
    depth: fc.integer({ min: 1, max: 4 }),
    positionsTested: fc.integer({ min: 0, max: 500 }),
  });
}

export interface ArbitraryRecordingOptions {
  /** Force zero Blunders (Requirement 24.5 edge case). */
  noBlunders?: boolean;
  /** Force an empty Best_Line (Requirement 24.5 edge case). */
  emptyBestLine?: boolean;
}

/**
 * Valid Recordings. Zero Blunders and an empty Best_Line occur naturally
 * (arrays may be empty) and can be forced via options. Keys are emitted in
 * design.md field order.
 */
export function arbitraryRecording(options: ArbitraryRecordingOptions = {}): fc.Arbitrary<Recording> {
  return fc.record({
    formatVersion: fc.constant<1>(1),
    targetFileName: fc.string({ minLength: 1, maxLength: 20 }),
    originalSource: arbitraryText(),
    originalMetrics: arbitraryMetrics(),
    originalScore: arbitraryScore(),
    searchSettings: arbitrarySettings(),
    coverage: arbitraryCoverage(),
    allLines: fc.array(arbitraryLine(), { maxLength: 4 }),
    bestLine: options.emptyBestLine ? fc.constant<MoveRecord[]>([]) : arbitraryMoveRecords(4),
    blunders: options.noBlunders
      ? fc.constant<BlunderRecord[]>([])
      : fc.array(arbitraryBlunder(), { maxLength: 3 }),
    progressEvents: fc.array(arbitraryProgressEvent(), { maxLength: 3 }),
  });
}
