import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, rejectApply, type ApplyFileSystem } from "./apply.js";
import type { MoveRecord } from "./recording.js";
import { APPLY_TEST_TIMEOUT_MS, type TestRunner } from "./test-runner.js";
import type { Metrics, Position, TestOutcome } from "./types.js";

const M: Metrics = {
  cyclomaticComplexity: 0,
  maxNestingDepth: 0,
  functionLength: 0,
  duplicatedCode: 0,
  unusedCode: 0,
};

function move(i: number, after: string): MoveRecord {
  return {
    index: i,
    kind: "RemoveUnused",
    displayName: "m",
    description: "d",
    annotation: "!",
    sourceBefore: "",
    sourceAfter: after,
    metricsBefore: M,
    metricsAfter: M,
    scoreBefore: 0,
    scoreAfter: 0,
  };
}

const TARGET = "/proj/target.ts";

class FakeFs implements ApplyFileSystem {
  files = new Map<string, string>();
  failWrite = false;
  failRename = false;
  async readFile(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error("ENOENT");
    return c;
  }
  async writeFile(p: string, c: string): Promise<void> {
    if (this.failWrite) throw new Error("EACCES");
    this.files.set(p, c);
  }
  async rename(a: string, b: string): Promise<void> {
    if (this.failRename) throw new Error("EXDEV");
    this.files.set(b, this.files.get(a)!);
    this.files.delete(a);
  }
  async rm(p: string): Promise<void> {
    this.files.delete(p);
  }
}

class FakeRunner implements TestRunner {
  calls: { position: Position; test: string; timeoutMs?: number }[] = [];
  constructor(private outcome: TestOutcome | Error) {}
  async run(position: Position, test: string, options?: { timeoutMs?: number }): Promise<TestOutcome> {
    this.calls.push({ position, test, timeoutMs: options?.timeoutMs });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
  async runWithCoverage(): Promise<never> {
    throw new Error("unused");
  }
}

function setup(outcome: TestOutcome | Error = { kind: "passed" }, disk = "orig") {
  const fs = new FakeFs();
  fs.files.set(TARGET, disk);
  const runner = new FakeRunner(outcome);
  const bestLine = [move(0, "a"), move(1, "b"), move(2, "c")];
  const run = (selection: Parameters<typeof applyChanges>[0]["selection"] = { kind: "best-line" }) =>
    applyChanges({
      targetFilePath: TARGET,
      originalSource: "orig",
      bestLine,
      selection,
      relevantTestFile: "/proj/target.test.ts",
      testRunner: runner,
      fs,
    });
  return { fs, runner, run };
}

describe("applyChanges", () => {
  it("applies the best line and reports L moves", async () => {
    const { fs, runner, run } = setup();
    expect(await run()).toEqual({ kind: "applied", path: TARGET, movesApplied: 3 });
    expect(fs.files.get(TARGET)).toBe("c");
    expect(runner.calls[0].position.sourceText).toBe("c");
    expect(runner.calls[0].timeoutMs).toBe(APPLY_TEST_TIMEOUT_MS);
    expect([...fs.files.keys()]).toEqual([TARGET]); // temp file gone
  });

  it("applies up to selected move with i + 1 moves", async () => {
    const { fs, run } = setup();
    expect(await run({ kind: "up-to-move", index: 1 })).toEqual({
      kind: "applied",
      path: TARGET,
      movesApplied: 2,
    });
    expect(fs.files.get(TARGET)).toBe("b");
  });

  it("refuses when the file changed, without running tests", async () => {
    const { fs, runner, run } = setup({ kind: "passed" }, "orig!");
    expect((await run()).kind).toBe("file-changed");
    expect(runner.calls).toHaveLength(0);
    expect(fs.files.get(TARGET)).toBe("orig!");
  });

  it.each([
    [{ kind: "failed", failures: [{ testName: "t" }] } as TestOutcome, "tests-failed"],
    [{ kind: "error", message: "x" } as TestOutcome, "could-not-run"],
    [{ kind: "timeout" } as TestOutcome, "timed-out"],
  ])("does not write on %j", async (outcome, kind) => {
    const { fs, run } = setup(outcome);
    expect((await run()).kind).toBe(kind);
    expect(fs.files.get(TARGET)).toBe("orig");
  });

  it("reports could-not-run when the runner throws or no test file exists", async () => {
    const a = setup(new Error("boom"));
    expect((await a.run()).kind).toBe("could-not-run");
    const b = setup();
    const r = await applyChanges({
      targetFilePath: TARGET,
      originalSource: "orig",
      bestLine: [move(0, "a")],
      selection: { kind: "best-line" },
      relevantTestFile: undefined,
      testRunner: b.runner,
      fs: b.fs,
    });
    expect(r.kind).toBe("could-not-run");
    expect(b.fs.files.get(TARGET)).toBe("orig");
  });

  it.each(["failWrite", "failRename"] as const)("preserves original on %s", async (flag) => {
    const { fs, run } = setup();
    fs[flag] = true;
    expect((await run()).kind).toBe("write-failed");
    expect([...fs.files.entries()]).toEqual([[TARGET, "orig"]]);
  });

  it("rejects invalid selections and reject does nothing", async () => {
    const { runner, run } = setup();
    expect((await run({ kind: "up-to-move", index: 3 })).kind).toBe("invalid-selection");
    expect(runner.calls).toHaveLength(0);
    expect(rejectApply()).toEqual({ kind: "rejected" });
  });

  it("Property 58: content selection and move count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
        fc.nat(),
        fc.boolean(),
        async (afters, n, whole) => {
          const fs = new FakeFs();
          fs.files.set(TARGET, "orig");
          const L = afters.length;
          const i = n % L;
          const r = await applyChanges({
            targetFilePath: TARGET,
            originalSource: "orig",
            bestLine: afters.map((a, k) => move(k, a)),
            selection: whole ? { kind: "best-line" } : { kind: "up-to-move", index: i },
            relevantTestFile: "t",
            testRunner: new FakeRunner({ kind: "passed" }),
            fs,
          });
          const idx = whole ? L - 1 : i;
          expect(r).toEqual({ kind: "applied", path: TARGET, movesApplied: idx + 1 });
          expect(fs.files.get(TARGET)).toBe(afters[idx]);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Property 59: freshness guard", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (disk, original) => {
        const fs = new FakeFs();
        fs.files.set(TARGET, disk);
        const runner = new FakeRunner({ kind: "passed" });
        const r = await applyChanges({
          targetFilePath: TARGET,
          originalSource: original,
          bestLine: [move(0, "new")],
          selection: { kind: "best-line" },
          relevantTestFile: "t",
          testRunner: runner,
          fs,
        });
        if (disk === original) {
          expect(runner.calls).toHaveLength(1);
        } else {
          expect(r.kind).toBe("file-changed");
          expect(runner.calls).toHaveLength(0);
          expect(fs.files.get(TARGET)).toBe(disk);
        }
      }),
      { numRuns: 50 },
    );
  });
});
