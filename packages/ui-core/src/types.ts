/**
 * Structural subsets of the engine's Recording types (packages/engine/src/recording.ts).
 * Declared locally so the view-models depend only on the fields they read; full engine
 * `MoveRecord`, `BlunderRecord`, and `Metrics` values are assignable to these.
 */
export interface Metrics {
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  functionLength: number;
  duplicatedCode: number;
  unusedCode: number;
}

export interface MoveRecord {
  displayName: string;
  annotation: "!!" | "!" | "?!" | "??";
  sourceBefore: string;
  sourceAfter: string;
}

export interface BlunderRecord {
  moveDescription: string;
  /** 1-based position within the Line that produced it. */
  lineIndex: number;
  failingTests: { testName: string; message?: string }[];
  failureReason?: "timeout" | "test execution error";
}
