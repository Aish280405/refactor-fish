import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MoveRecord } from "./recording.js";
import { APPLY_TEST_TIMEOUT_MS, type TestRunner } from "./test-runner.js";
import type { TestFailure } from "./types.js";

/** Minimal file-system surface used by the apply pipeline (injectable for tests). */
export interface ApplyFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string): Promise<void>;
}

export const nodeApplyFileSystem: ApplyFileSystem = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, c) => writeFile(p, c, "utf8"),
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { force: true }),
};

export type ApplySelection =
  | { kind: "best-line" }
  /** Apply up to and including the Move at `index` of the Best_Line. */
  | { kind: "up-to-move"; index: number };

export interface ApplyRequest {
  /** Absolute path of the real Target_File. */
  targetFilePath: string;
  /** The original Position's source text (what the Search ran against). */
  originalSource: string;
  bestLine: readonly MoveRecord[];
  selection: ApplySelection;
  /** Absolute path of the Relevant_Test_File; undefined when none was found. */
  relevantTestFile: string | undefined;
  /** Runs tests against a temp copy; must never write the real Target_File. */
  testRunner: TestRunner;
  /** Defaults to the real file system. */
  fs?: ApplyFileSystem;
  /** Defaults to APPLY_TEST_TIMEOUT_MS (300 s). */
  timeoutMs?: number;
}

export type ApplyResult =
  /** Requirements 21.2, 21.3, 21.6 */
  | { kind: "applied"; path: string; movesApplied: number }
  /** Requirement 21.5: disk differs from the original Position; no tests run, no write. */
  | { kind: "file-changed"; message: string }
  /** Requirement 21.8: at least one test failed. */
  | { kind: "tests-failed"; failures: TestFailure[]; message: string }
  /** Requirement 21.8: tests could not be run. */
  | { kind: "could-not-run"; message: string }
  /** Requirement 21.8: tests did not finish in time. */
  | { kind: "timed-out"; message: string }
  /** Requirement 21.9: write failed; the original content is preserved. */
  | { kind: "write-failed"; message: string }
  /** The Target_File could not be read for the freshness check; nothing was run or written. */
  | { kind: "read-failed"; message: string }
  /** The selection does not refer to a Move in the Best_Line; nothing was done. */
  | { kind: "invalid-selection"; message: string };

/** Requirement 21.4: Reject never touches the file. */
export function rejectApply(): { kind: "rejected" } {
  return { kind: "rejected" };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Picks the content to write and the number of Moves it represents. */
export function selectApplyContent(
  bestLine: readonly MoveRecord[],
  selection: ApplySelection,
): { source: string; movesApplied: number } | undefined {
  const L = bestLine.length;
  if (L === 0) return undefined;
  const i = selection.kind === "best-line" ? L - 1 : selection.index;
  if (!Number.isInteger(i) || i < 0 || i >= L) return undefined;
  return { source: bestLine[i].sourceAfter, movesApplied: i + 1 };
}

/**
 * Strict pipeline: freshness check -> test run -> atomic write.
 * Each step is gated on the previous one succeeding.
 */
export async function applyChanges(req: ApplyRequest): Promise<ApplyResult> {
  const fs = req.fs ?? nodeApplyFileSystem;
  const selected = selectApplyContent(req.bestLine, req.selection);
  if (!selected) {
    return { kind: "invalid-selection", message: "The selected move is not part of the Best_Line." };
  }

  // 1. Freshness: byte-equal to the original Position.
  let onDisk: string;
  try {
    onDisk = await fs.readFile(req.targetFilePath);
  } catch (e) {
    return { kind: "read-failed", message: `Could not read ${req.targetFilePath}: ${errMsg(e)}` };
  }
  if (onDisk !== req.originalSource) {
    return { kind: "file-changed", message: "The file changed since analysis; nothing was written." };
  }

  // 2. Tests against the Position to be written.
  if (req.relevantTestFile === undefined) {
    return { kind: "could-not-run", message: "No relevant test file was found; nothing was written." };
  }
  let outcome;
  try {
    outcome = await req.testRunner.run(
      { sourceText: selected.source, filePath: path.basename(req.targetFilePath) },
      req.relevantTestFile,
      { timeoutMs: req.timeoutMs ?? APPLY_TEST_TIMEOUT_MS },
    );
  } catch (e) {
    return { kind: "could-not-run", message: `Tests could not be run: ${errMsg(e)}` };
  }
  switch (outcome.kind) {
    case "passed":
      break;
    case "failed":
      return {
        kind: "tests-failed",
        failures: outcome.failures,
        message: "Tests failed; nothing was written.",
      };
    case "error":
      return { kind: "could-not-run", message: `Tests could not be run: ${outcome.message}` };
    case "timeout":
      return { kind: "timed-out", message: "Tests timed out; nothing was written." };
  }

  // 3. Atomic write: temp file in the same directory, then rename.
  const tmp = path.join(
    path.dirname(req.targetFilePath),
    `.${path.basename(req.targetFilePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(tmp, selected.source);
    await fs.rename(tmp, req.targetFilePath);
  } catch (e) {
    await fs.rm(tmp).catch(() => undefined);
    return { kind: "write-failed", message: `Write failed; original file preserved: ${errMsg(e)}` };
  }
  return { kind: "applied", path: req.targetFilePath, movesApplied: selected.movesApplied };
}
