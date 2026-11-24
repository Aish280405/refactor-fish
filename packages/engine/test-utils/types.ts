/**
 * Structural types used by the test helpers.
 *
 * Core types are re-exported from `src/types.ts`. Types that do not exist there
 * yet (Recording shapes, TestRunner) mirror design.md and should be replaced
 * with re-exports when their tasks land.
 */

import type {
  Annotation,
  LLMMoveProposal,
  LLMProvider,
  Metrics,
  MoveKind,
  Position,
  TestFailure,
  TestOutcome,
} from "../src/types.js";

// Shared core types come from src/types.ts; the rest (Recording shapes, runner) are declared below.
export type { Annotation, LLMMoveProposal, Metrics, MoveKind, Position, TestFailure, TestOutcome };

export interface CoverageResult {
  percent: number;
  unknown: boolean;
}

export interface TestRunnerLike {
  run(position: Position, relevantTestFile: string): Promise<TestOutcome>;
  runWithCoverage(
    position: Position,
    relevantTestFile: string,
  ): Promise<{ outcome: TestOutcome; coverage: CoverageResult }>;
}

export type LLMProviderLike = LLMProvider;

export type {
  BlunderRecord,
  CoverageInfo,
  LineRecord,
  MoveRecord,
  ProgressEventRecord,
  Recording,
  SearchSettings,
} from "../src/recording.js";
