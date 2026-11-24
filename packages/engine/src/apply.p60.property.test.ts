// Feature: refactor-fish, Property 60: Apply test-outcome gating
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbitraryTestOutcome } from "../test-utils/index.js";
import { applyChanges, type ApplyFileSystem } from "./apply.js";
import type { MoveRecord } from "./recording.js";
import { APPLY_TEST_TIMEOUT_MS, type TestRunner } from "./test-runner.js";
import type { Metrics, Position, TestOutcome } from "./types.js";

/**
 * Property 60: For any TestOutcome produced for the Position to be written (passed, failed,
 * error, or timeout), the apply action writes to the Target_File iff the outcome is "passed",
 * and otherwise leaves the Target_File unchanged and reports the outcome (tests failed,
 * could not run, or timed out).
 *
 * **Validates: Requirements 21.7, 21.8**
 */

const M: Metrics = {
  cyclomaticComplexity: 0,
  maxNestingDepth: 0,
  functionLength: 0,
  duplicatedCode: 0,
  unusedCode: 0,
};

const TARGET = "/proj/src/target.ts";
const TEST_FILE = "/proj/src/target.test.ts";

function move(i: number, before: string, after: string): MoveRecord {
  return {
    index: i,
    kind: "RemoveUnused",
    displayName: "m",
    description: "d",
    annotation: "!",
    sourceBefore: before,
    sourceAfter: after,
    metricsBefore: M,
    metricsAfter: M,
    scoreBefore: 0,
    scoreAfter: 0,
  };
}

class SpyFs implements ApplyFileSystem {
  files = new Map<string, string>();
  writes = 0;
  renames = 0;
  async readFile(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error("ENOENT");
    return c;
  }
  async writeFile(p: string, c: string): Promise<void> {
    this.writes++;
    this.files.set(p, c);
  }
  async rename(a: string, b: string): Promise<void> {
    this.renames++;
    const c = this.files.get(a);
    if (c === undefined) throw new Error("ENOENT");
    this.files.set(b, c);
    this.files.delete(a);
  }
  async rm(p: string): Promise<void> {
    this.files.delete(p);
  }
}

type RunnerBehavior = { kind: "outcome"; outcome: TestOutcome } | { kind: "throw"; message: string };

class ScriptedRunner implements TestRunner {
  calls: { position: Position; testFile: string; options?: { timeoutMs?: number } }[] = [];
  constructor(private readonly behavior: RunnerBehavior) {}
  async run(position: Position, testFile: string, options?: { timeoutMs?: number }): Promise<TestOutcome> {
    this.calls.push({ position, testFile, options });
    if (this.behavior.kind === "throw") throw new Error(this.behavior.message);
    return this.behavior.outcome;
  }
  async runWithCoverage(): Promise<never> {
    throw new Error("unused");
  }
}

const behaviorArb: fc.Arbitrary<RunnerBehavior> = fc.oneof(
  { weight: 4, arbitrary: arbitraryTestOutcome().map<RunnerBehavior>((outcome) => ({ kind: "outcome", outcome })) },
  { weight: 1, arbitrary: fc.string().map<RunnerBehavior>((message) => ({ kind: "throw", message })) },
);

/** Original source plus a Best_Line whose sourceAfter texts are distinct from each other and from the original. */
const scenario = fc
  .uniqueArray(fc.string({ maxLength: 40 }), { minLength: 2, maxLength: 6 })
  .chain(([original, ...afters]) =>
    fc.record({
      original: fc.constant(original),
      afters: fc.constant(afters),
      selection: fc.oneof(
        fc.constant({ kind: "best-line" as const }),
        fc.integer({ min: 0, max: afters.length - 1 }).map((index) => ({ kind: "up-to-move" as const, index })),
      ),
      behavior: behaviorArb,
    }),
  );

describe("Property 60: Apply test-outcome gating", () => {
  it("writes iff the outcome is passed; otherwise leaves the file unchanged and reports the outcome", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ original, afters, selection, behavior }) => {
        const bestLine = afters.map((a, k) => move(k, k === 0 ? original : afters[k - 1], a));
        const idx = selection.kind === "best-line" ? afters.length - 1 : selection.index;
        const expectedSource = afters[idx];

        const fs = new SpyFs();
        fs.files.set(TARGET, original);
        const runner = new ScriptedRunner(behavior);

        const result = await applyChanges({
          targetFilePath: TARGET,
          originalSource: original,
          bestLine,
          selection,
          relevantTestFile: TEST_FILE,
          testRunner: runner,
          fs,
        });

        // The run targets exactly the Position to be written, with the 300 s apply timeout.
        expect(runner.calls).toHaveLength(1);
        expect(runner.calls[0].position.sourceText).toBe(expectedSource);
        expect(runner.calls[0].testFile).toBe(TEST_FILE);
        expect(runner.calls[0].options?.timeoutMs).toBe(APPLY_TEST_TIMEOUT_MS);
        expect(APPLY_TEST_TIMEOUT_MS).toBe(300_000);

        const passed = behavior.kind === "outcome" && behavior.outcome.kind === "passed";
        if (passed) {
          expect(result).toEqual({ kind: "applied", path: TARGET, movesApplied: idx + 1 });
          expect(fs.files.get(TARGET)).toBe(expectedSource);
          expect([...fs.files.keys()]).toEqual([TARGET]);
          return;
        }

        // Not passed: disk untouched, byte-identical.
        expect(fs.writes).toBe(0);
        expect(fs.renames).toBe(0);
        expect([...fs.files.entries()]).toEqual([[TARGET, original]]);

        if (behavior.kind === "throw") {
          expect(result.kind).toBe("could-not-run");
          return;
        }
        const outcome = behavior.outcome;
        switch (outcome.kind) {
          case "failed":
            expect(result.kind).toBe("tests-failed");
            if (result.kind === "tests-failed") expect(result.failures).toEqual(outcome.failures);
            break;
          case "error":
            expect(result.kind).toBe("could-not-run");
            break;
          case "timeout":
            expect(result.kind).toBe("timed-out");
            break;
        }
        expect("message" in result && typeof result.message === "string" && result.message.length > 0).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
