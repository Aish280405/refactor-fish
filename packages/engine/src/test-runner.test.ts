import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRelevantTestFile, VitestTestRunner } from "./test-runner.js";

const created: string[] = [];
const NODE_MODULES = path.resolve(import.meta.dirname, "../../../node_modules");

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-proj-"));
  created.push(root);
  await symlink(NODE_MODULES, path.join(root, "node_modules"), "dir");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  return root;
}

afterEach(async () => {
  for (const d of created.splice(0)) {
    await rm(path.join(d, "node_modules"), { force: true });
    await rm(d, { recursive: true, force: true });
  }
});

const SRC = `export function add(a: number, b: number) {
  if (a > 1000) { return -1; }
  return a + b;
}
`;
const TEST = `import { it, expect } from "vitest";
import { add } from "./add.js";
it("adds", () => { expect(add(1, 2)).toBe(3); });
`;

async function setup(extra: Record<string, string> = {}) {
  const root = await makeProject({ "add.ts": SRC, "add.test.ts": TEST, ...extra });
  const target = path.join(root, "add.ts");
  const runner = new VitestTestRunner({ projectRoot: root, targetFilePath: target, timeoutMs: 30_000 });
  return { root, target, runner, testFile: path.join(root, "add.test.ts") };
}

describe("findRelevantTestFile", () => {
  it("finds the test importing the target and returns undefined otherwise", async () => {
    const { root, target, testFile } = await setup();
    expect(await findRelevantTestFile(target, root)).toBe(testFile);
    expect(await findRelevantTestFile(path.join(root, "other.ts"), root)).toBeUndefined();
  });
});

describe("VitestTestRunner", () => {
  it("passes, fails, and never modifies the real target", async () => {
    const { target, runner, testFile } = await setup();
    const pos = { sourceText: SRC, filePath: "add.ts" };
    expect(await runner.run(pos, testFile)).toEqual({ kind: "passed" });

    const broken = { sourceText: SRC.replace("a + b", "a - b"), filePath: "add.ts" };
    const out = await runner.run(broken, testFile);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.failures[0].testName).toContain("adds");
      expect(out.failures[0].message).toBeTruthy();
    }
    expect(await readFile(target, "utf8")).toBe(SRC);
  }, 60_000);

  it("reports error for unparseable candidates and zero tests", async () => {
    const { runner, testFile, root } = await setup({ "empty.test.ts": `import "./add.js";\n` });
    const bad = await runner.run({ sourceText: "export const = ;", filePath: "add.ts" }, testFile);
    expect(bad.kind).toBe("error");
    const zero = await runner.run({ sourceText: SRC, filePath: "add.ts" }, path.join(root, "empty.test.ts"));
    expect(zero.kind).toBe("error");
  }, 60_000);

  it("times out and cleans up the temp directory", async () => {
    const hang = `import { it } from "vitest";
import "./add.js";
it("hangs", async () => { await new Promise(() => {}); }, 120000);
`;
    const { root, target } = await setup({ "hang.test.ts": hang });
    const runner = new VitestTestRunner({ projectRoot: root, targetFilePath: target, timeoutMs: 3_000 });
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith("refactor-fish-"));
    const out = await runner.run({ sourceText: SRC, filePath: "add.ts" }, path.join(root, "hang.test.ts"));
    expect(out).toEqual({ kind: "timeout" });
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith("refactor-fish-"));
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  }, 60_000);

  it("measures raw statement coverage of the target", async () => {
    const { runner, testFile } = await setup();
    const res = await runner.runWithCoverage({ sourceText: SRC, filePath: "add.ts" }, testFile);
    expect(res.outcome).toEqual({ kind: "passed" });
    expect(res.coverage).not.toBeNull();
    expect(res.coverage!.totalStatements).toBeGreaterThan(0);
    expect(res.coverage!.executedStatements).toBeLessThan(res.coverage!.totalStatements);
    expect(res.coverage!.executedStatements).toBeGreaterThan(0);
  }, 60_000);
});
