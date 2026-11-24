import { createHash } from "node:crypto";

/** An immutable snapshot of the Target_File's source text. */
export interface Position {
  readonly sourceText: string;
  /** Virtual path, e.g. "target.ts", used for the in-memory project. */
  readonly filePath: string;
}

export type MoveKind =
  | "RemoveUnused"
  | "InlineVariable"
  | "GuardClause"
  | "SimplifyBoolean"
  | "ExtractFunction"
  | "LLMMove";

export interface ApplyResult {
  ok: boolean;
  /** Present when ok. */
  resultingSource?: string;
  /** Present when !ok. */
  error?: { reason: string };
}

export interface Candidate {
  move: MoveKind;
  displayName: string;
  /** Human-readable description, stored in logs/Recording. */
  describe(): string;
  /** Pure: does not mutate `position`. */
  apply(position: Position): ApplyResult;
}

export interface LLMMoveProposal {
  title: string;
  /** Full candidate file content proposed by the LLM. */
  resultingSource: string;
}

export interface LLMProvider {
  proposeMoves(
    position: Position,
    maxProposals: number,
    timeoutMs: number,
  ): Promise<LLMMoveProposal[]>;
}

export interface DiscardLogEntry {
  /** Why the proposal was discarded. */
  kind: "parse-failure" | "no-change" | "tests-failed";
  /** Human-readable reason (e.g. parse failure message). */
  reason: string;
  /** Title or description of the discarded proposal, if known. */
  proposalTitle?: string;
  /** The proposal's source text, if available. */
  proposalSource?: string;
}

export interface GeneratorContext {
  llmProvider?: LLMProvider;
  /** Appended to for LLM discards (Requirements 9.3, 9.6, 9.8). */
  discardLog: DiscardLogEntry[];
}

export interface MoveGenerator {
  generate(position: Position, context: GeneratorContext): Promise<Candidate[]>;
}

export interface TestFailure {
  testName: string;
  message?: string;
}

export type TestOutcome =
  | { kind: "passed" }
  | { kind: "failed"; failures: TestFailure[] }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

export interface Metrics {
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  functionLength: number;
  duplicatedCode: number;
  unusedCode: number;
}

export type Annotation = "!!" | "!" | "?!" | "??";

/** SHA-256 hex digest of the exact source text (UTF-8). */
export function contentHash(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}
