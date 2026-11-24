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
