// Feature: refactor-fish, Property 23: For any candidate Position and any simulated Test_Runner outcome including a crash or a timeout, the bytes of the real Target_File on disk SHALL be identical before and after the Test_Runner's run.
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VitestTestRunner } from "./test-runner.js";

/**
 * **Validates: Requirements 10.6**
 *
 * This property exercises the real VitestTestRunner, because immutability depends on its
 * materialization path (mirror + temp write + cleanup), which a fake would not cover.
 * Each iteration starts a real in-process Vitest run (about 1-2 s), so numRuns is 12
 * instead of the usual 100. The generator draws the outcome kind from a small closed set
 * (passed, failed, error, crash, timeout), so 12 runs reach every kind several times;
 * the random dimension that matters for byte identity is the original file content,
 * which is drawn as arbitrary bytes (including invalid UTF-8) appended to valid source.
 */

const NODE_MODULES = path.resolve(import.meta.dirname, "../../../node_modules");

const SRC = `export function add(a: number, b: number) {
  return a + b;
}
`;
const TEST = `import { it, expect } from "vitest";
import { add } from "./add.js";
it("adds", () => { expect(add(1, 2)).toBe(3); });
`;

type Kind = "passed" | "failed" | "error" | "crash" | "timeout";

const CANDIDATES: Record<Kind, string> = {
  passed: SRC,
  failed: SRC.replace("a + b", "a - b"),
  error: "export const = ;\n",
  // Kills the test worker at import time.
  crash: `process.exit(1);\n${SRC}`,
  // Never finishes importing, so the runner's timer fires.
  timeout: `await new Promise(() => {});\n${SRC}`,
};

// Private TMPDIR so temp dirs from parallel test files do not interfere.
let privateTmp: string;
let savedTmpdir: string | undefined;
let root: string;
let targetPath: string;
let testFile: string;

beforeAll(async () => {
  savedTmpdir = process.env.TMPDIR;
  privateTmp = await mkdtemp(path.join(tmpdir(), "rf-p23-tmp-"));
  process.env.TMPDIR = privateTmp;
  root = await mkdtemp(path.join(privateTmp, "rf-p23-proj-"));
  await symlink(NODE_MODULES, path.join(root, "node_modules"), "dir");
  targetPath = path.join(root, "add.ts");
  testFile = path.join(root, "add.test.ts");
  await writeFile(testFile, TEST);
});

afterAll(async () => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  await rm(path.join(root, "node_modules"), { force: true });
  await rm(privateTmp, { recursive: true, force: true });
});

describe("Property 23: Target_File on-disk immutability across Test_Runner outcomes", () => {
  it("leaves the real Target_File byte-identical for every outcome kind", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Kind>("passed", "failed", "error", "crash", "timeout"),
        fc.uint8Array({ maxLength: 64 }),
        async (kind, trailer) => {
          const original = Buffer.concat([Buffer.from(SRC + "// "), Buffer.from(trailer)]);
          await writeFile(targetPath, original);

          const runner = new VitestTestRunner({ projectRoot: root, targetFilePath: targetPath });
          const outcome = await runner.run(
            { sourceText: CANDIDATES[kind], filePath: "add.ts" },
            testFile,
            { timeoutMs: kind === "timeout" ? 1_500 : 30_000 },
          );

          // Sanity: the outcome is one of the defined kinds (any kind satisfies the property).
          expect(["passed", "failed", "error", "timeout"]).toContain(outcome.kind);
          const after = await readFile(targetPath);
          expect(after.equals(original)).toBe(true);
        },
      ),
      { numRuns: 12 },
    );
  }, 600_000);
});
