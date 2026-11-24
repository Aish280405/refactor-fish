import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChanges, nodeApplyFileSystem, rejectApply } from "./apply.js";
import type { MoveRecord } from "./recording.js";
import type { TestRunner } from "./test-runner.js";
import type { Metrics, TestOutcome } from "./types.js";

// Unit tests for apply edge cases on the real file system.
// Validates: Requirements 21.4, 21.9

const M: Metrics = {
  cyclomaticComplexity: 0,
  maxNestingDepth: 0,
  functionLength: 0,
  duplicatedCode: 0,
  unusedCode: 0,
};

function move(after: string): MoveRecord {
  return {
    index: 0,
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

const passingRunner: TestRunner = {
  async run(): Promise<TestOutcome> {
    return { kind: "passed" };
  },
  async runWithCoverage(): Promise<never> {
    throw new Error("unused");
  },
};

const ORIGINAL = "export function f(x: number) {\n  const unused = 1;\n  return x;\n}\n";
const REFACTORED = "export function f(x: number) {\n  return x;\n}\n";

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rf-apply-unit-"));
  target = path.join(dir, "target.ts");
  await writeFile(target, ORIGINAL, "utf8");
});

afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("rejectApply on the real file system", () => {
  it("leaves the Target_File byte-identical (content and mtime)", async () => {
    const beforeBytes = await readFile(target);
    const beforeStat = await stat(target);

    expect(rejectApply()).toEqual({ kind: "rejected" });

    const afterBytes = await readFile(target);
    const afterStat = await stat(target);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readdir(dir)).toEqual(["target.ts"]);
  });
});

describe("applyChanges write failure via nodeApplyFileSystem", () => {
  it("reports write-failed, preserves the original, and leaves no temp files", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    await chmod(dir, 0o555);
    // Root (or some file systems) ignore directory permissions; skip if writes still succeed.
    const probe = path.join(dir, ".probe");
    const writable = await writeFile(probe, "x").then(
      () => true,
      () => false,
    );
    if (writable) {
      await chmod(dir, 0o755);
      await rm(probe, { force: true });
      ctx.skip();
    }
    const beforeBytes = await readFile(target);

    const result = await applyChanges({
      targetFilePath: target,
      originalSource: ORIGINAL,
      bestLine: [move(REFACTORED)],
      selection: { kind: "best-line" },
      relevantTestFile: path.join(dir, "target.test.ts"),
      testRunner: passingRunner,
      fs: nodeApplyFileSystem,
    });

    expect(result.kind).toBe("write-failed");
    if (result.kind === "write-failed") expect(result.message).toMatch(/write failed/i);
    expect((await readFile(target)).equals(beforeBytes)).toBe(true);
    expect(await readdir(dir)).toEqual(["target.ts"]);
  });
});
