import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { VitestTestRunner } from "./test-runner.js";

const created: string[] = [];
const NODE_MODULES = path.resolve(import.meta.dirname, "../../../node_modules");

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-unit-"));
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
  return a + b;
}
`;
const TEST = `import { it, expect } from "vitest";
import { add } from "./add.js";
it("adds", () => { expect(add(1, 2)).toBe(3); });
`;

async function setup(extra: Record<string, string> = {}) {
  const root = await makeProject({ "add.ts": SRC, "add.test.ts": TEST, ...extra });
  const runner = new VitestTestRunner({
    projectRoot: root,
    targetFilePath: path.join(root, "add.ts"),
    timeoutMs: 30_000,
  });
  return { root, runner, testFile: path.join(root, "add.test.ts") };
}

// Use a private TMPDIR so runs from other test files in parallel workers do not interfere.
let privateTmp: string;
let savedTmpdir: string | undefined;

beforeAll(async () => {
  savedTmpdir = process.env.TMPDIR;
  privateTmp = await mkdtemp(path.join(tmpdir(), "rf-private-tmp-"));
  process.env.TMPDIR = privateTmp;
});

afterAll(async () => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  await rm(privateTmp, { recursive: true, force: true });
});

const tempDirs = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("refactor-fish-"));

describe("VitestTestRunner (unit)", () => {
  it("returns error when the candidate imports a missing dependency", async () => {
    const { runner, testFile } = await setup();
    const candidate = `import { nope } from "definitely-not-installed-pkg-xyz";
export function add(a: number, b: number) { return nope(a, b); }
`;
    const out = await runner.run({ sourceText: candidate, filePath: "add.ts" }, testFile);
    expect(out.kind).toBe("error");
  }, 60_000);

  it("removes the temp directory after a failed run", async () => {
    const { runner, testFile } = await setup();
    const before = await tempDirs();
    const out = await runner.run(
      { sourceText: SRC.replace("a + b", "a - b"), filePath: "add.ts" },
      testFile,
    );
    expect(out.kind).toBe("failed");
    expect((await tempDirs()).filter((n) => !before.includes(n))).toEqual([]);
  }, 60_000);

  it("removes the temp directory after an error run", async () => {
    const { runner, testFile } = await setup();
    const before = await tempDirs();
    const out = await runner.run({ sourceText: "export const = ;", filePath: "add.ts" }, testFile);
    expect(out.kind).toBe("error");
    expect((await tempDirs()).filter((n) => !before.includes(n))).toEqual([]);
  }, 60_000);

  it("runs only the Relevant_Test_File, not the full suite", async () => {
    const other = `import { it, expect } from "vitest";
import "./add.js";
it("unrelated failing test", () => { expect(1).toBe(2); });
`;
    const { runner, testFile } = await setup({ "other.test.ts": other });
    const out = await runner.run({ sourceText: SRC, filePath: "add.ts" }, testFile);
    expect(out).toEqual({ kind: "passed" });
  }, 60_000);

  it("classifies a run exceeding the timeout as timeout", async () => {
    const hang = `import { it } from "vitest";
import "./add.js";
it("hangs", async () => { await new Promise(() => {}); }, 120000);
`;
    const { runner, root } = await setup({ "hang.test.ts": hang });
    const out = await runner.run(
      { sourceText: SRC, filePath: "add.ts" },
      path.join(root, "hang.test.ts"),
      { timeoutMs: 2_000 },
    );
    expect(out).toEqual({ kind: "timeout" });
  }, 60_000);
});
