// Feature: refactor-fish, Property 58: Apply content selection and move count
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, selectApplyContent, type ApplyFileSystem, type ApplySelection } from "./apply.js";
import type { MoveRecord } from "./recording.js";
import type { TestRunner } from "./test-runner.js";
import type { Metrics, Position, TestOutcome } from "./types.js";

/**
 * Property 58: For any Best_Line of length L >= 1 and any selected index 0 <= i < L,
 * "Apply up to selected move" writes the `sourceAfter` of the Move at index i and reports
 * i + 1 Moves applied; "Apply best line" writes the `sourceAfter` of the Move at index L - 1
 * and reports L Moves applied.
 *
 * **Validates: Requirements 21.2, 21.3, 21.6**
 */

const M: Metrics = {
  cyclomaticComplexity: 0,
  maxNestingDepth: 0,
  functionLength: 0,
  duplicatedCode: 0,
  unusedCode: 0,
};

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

class FakeFs implements ApplyFileSystem {
  files = new Map<string, string>();
  async readFile(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error("ENOENT");
    return c;
  }
  async writeFile(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async rename(a: string, b: string): Promise<void> {
    const c = this.files.get(a);
    if (c === undefined) throw new Error("ENOENT");
    this.files.set(b, c);
    this.files.delete(a);
  }
  async rm(p: string): Promise<void> {
    this.files.delete(p);
  }
}

class PassingRunner implements TestRunner {
  calls: Position[] = [];
  async run(position: Position): Promise<TestOutcome> {
    this.calls.push(position);
    return { kind: "passed" };
  }
  async runWithCoverage(): Promise<never> {
    throw new Error("unused");
  }
}

const targetPath = fc
  .tuple(
    fc.array(fc.stringMatching(/^[a-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 3 }),
    fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/),
    fc.constantFrom(".ts", ".tsx"),
  )
  .map(([dirs, name, ext]) => `/${dirs.join("/")}/${name}${ext}`);

/** Original source plus a Best_Line whose `sourceAfter` texts are pairwise distinct and differ from the original. */
const scenario = fc
  .uniqueArray(fc.string({ maxLength: 40 }), { minLength: 2, maxLength: 9 })
  .chain(([original, ...afters]) =>
    fc.record({
      original: fc.constant(original),
      afters: fc.constant(afters),
      index: fc.integer({ min: 0, max: afters.length - 1 }),
      target: targetPath,
    }),
  );

async function runApply(
  target: string,
  original: string,
  bestLine: MoveRecord[],
  selection: ApplySelection,
) {
  const fs = new FakeFs();
  fs.files.set(target, original);
  const runner = new PassingRunner();
  const result = await applyChanges({
    targetFilePath: target,
    originalSource: original,
    bestLine,
    selection,
    relevantTestFile: "/tests/target.test.ts",
    testRunner: runner,
    fs,
  });
  return { fs, runner, result };
}

describe("Property 58: Apply content selection and move count", () => {
  it("writes sourceAfter of the selected Move and reports the matching move count", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ original, afters, index, target }) => {
        const L = afters.length;
        const bestLine = afters.map((a, k) => move(k, k === 0 ? original : afters[k - 1], a));

        const cases: { selection: ApplySelection; idx: number }[] = [
          { selection: { kind: "up-to-move", index }, idx: index },
          { selection: { kind: "best-line" }, idx: L - 1 },
        ];

        for (const { selection, idx } of cases) {
          expect(selectApplyContent(bestLine, selection)).toEqual({
            source: afters[idx],
            movesApplied: idx + 1,
          });

          const { fs, runner, result } = await runApply(target, original, bestLine, selection);
          expect(result).toEqual({ kind: "applied", path: target, movesApplied: idx + 1 });
          // The selected content is what was tested and what was written.
          expect(runner.calls).toHaveLength(1);
          expect(runner.calls[0].sourceText).toBe(afters[idx]);
          expect(fs.files.get(target)).toBe(afters[idx]);
          // Only the Target_File remains (temp file renamed away).
          expect([...fs.files.keys()]).toEqual([target]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
