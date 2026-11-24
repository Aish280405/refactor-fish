import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Position, TestFailure, TestOutcome } from "./types.js";

/** Default per-candidate timeout (Requirement 10.7). */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
/** Timeout used for the final run performed by the Apply flow (Requirement 21.7). */
export const APPLY_TEST_TIMEOUT_MS = 300_000;

/** Raw statement counts for the Target_File; percentage math lives in task 13.3. */
export interface RawCoverage {
  executedStatements: number;
  totalStatements: number;
}

export interface CoverageRunResult {
  outcome: TestOutcome;
  /** null when coverage could not be measured. */
  coverage: RawCoverage | null;
}

export interface TestRunnerOptions {
  /** Absolute project root; mirrored into the temp directory. */
  projectRoot: string;
  /** Absolute path of the real Target_File (read-only: never written). */
  targetFilePath: string;
  /** Timeout in ms (default 60 000). */
  timeoutMs?: number;
}

export interface TestRunner {
  run(position: Position, relevantTestFile: string, options?: { timeoutMs?: number }): Promise<TestOutcome>;
  runWithCoverage(
    position: Position,
    relevantTestFile: string,
    options?: { timeoutMs?: number },
  ): Promise<CoverageRunResult>;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".vite", ".kiro"]);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;
const CONFIG_RE = /^vite(st)?\.config\.(ts|mts|cts|js|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// Relevant_Test_File discovery
// ---------------------------------------------------------------------------

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), out);
    } else if (e.isFile() && TEST_FILE_RE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.(?:mock|importActual)\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1]);
  return specs;
}

function stripExt(p: string): string {
  return p.replace(/\.(d\.)?(tsx?|mts|cts|jsx?|mjs|cjs)$/, "");
}

/**
 * Finds the test file that imports the Target_File (by relative specifier, with or
 * without extension). Returns an absolute path, or undefined when none exists.
 * Candidates are ordered: same directory first, then shortest path, then alphabetical.
 */
export async function findRelevantTestFile(
  targetFilePath: string,
  projectRoot: string,
): Promise<string | undefined> {
  const target = stripExt(path.resolve(targetFilePath));
  const files: string[] = [];
  await walk(path.resolve(projectRoot), files);
  const matches: string[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith(".")) continue;
      if (stripExt(path.resolve(path.dirname(file), spec)) === target) {
        matches.push(file);
        break;
      }
    }
  }
  const targetDir = path.dirname(targetFilePath);
  matches.sort((a, b) => {
    const sa = path.dirname(a) === targetDir ? 0 : 1;
    const sb = path.dirname(b) === targetDir ? 0 : 1;
    return sa - sb || a.length - b.length || a.localeCompare(b);
  });
  return matches[0];
}

// ---------------------------------------------------------------------------
// Temp materialization
// ---------------------------------------------------------------------------

async function mirror(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await mirror(path.join(src, e.name), path.join(dest, e.name));
    } else if (e.isFile()) {
      // Files are copied (not symlinked) so Vite never resolves back to the real file.
      await cp(path.join(src, e.name), path.join(dest, e.name));
    }
  }
}

function findNodeModules(from: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

interface TaskLike {
  name: string;
  type?: string;
  mode?: string;
  tasks?: TaskLike[];
  result?: { state?: string; errors?: { message?: string; stack?: string }[] };
}

interface Collected {
  executed: number;
  failures: TestFailure[];
}

function collect(tasks: TaskLike[], prefix: string[], acc: Collected): void {
  for (const t of tasks) {
    const name = [...prefix, t.name];
    if (t.tasks && t.type !== "test") {
      collect(t.tasks, name, acc);
      continue;
    }
    const state = t.result?.state;
    if (state === "pass") acc.executed++;
    else if (state === "fail") {
      acc.executed++;
      const message = t.result?.errors?.map((e) => e.message ?? "").filter(Boolean).join("\n");
      acc.failures.push({ testName: name.join(" > "), ...(message ? { message } : {}) });
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface VitestLike {
  start(filters?: string[]): Promise<unknown>;
  close(): Promise<void>;
  state: { getFiles(): (TaskLike & { filepath?: string })[] };
}

function mapOutcome(
  vitest: VitestLike,
  unhandled: unknown[],
  fileErrors: string[],
): TestOutcome {
  const files = vitest.state.getFiles() as TaskLike[];
  const acc: Collected = { executed: 0, failures: [] };
  collect(files, [], acc);
  // File-level failures (import/syntax/missing dependency) => unrunnable.
  for (const f of files) {
    if (f.result?.state === "fail") {
      const msg = f.result.errors?.map((e) => e.message ?? "").filter(Boolean).join("\n");
      fileErrors.push(msg || `Test file failed to run: ${f.name}`);
    }
  }
  if (fileErrors.length > 0 && acc.failures.length === 0) {
    return { kind: "error", message: fileErrors.join("\n") };
  }
  if (acc.failures.length > 0) return { kind: "failed", failures: acc.failures };
  if (acc.executed === 0) {
    return { kind: "error", message: "No tests were executed (0 tests collected)." };
  }
  if (unhandled.length > 0) {
    const msg = unhandled.map((e) => (e as { message?: string })?.message ?? String(e)).join("\n");
    return { kind: "error", message: `Unhandled errors during test run: ${msg}` };
  }
  return { kind: "passed" };
}

// ---------------------------------------------------------------------------
// Coverage JSON
// ---------------------------------------------------------------------------

interface IstanbulFileCoverage {
  s?: Record<string, number>;
  statementMap?: Record<string, unknown>;
}

async function readRawCoverage(
  reportsDir: string,
  targetRelative: string,
): Promise<RawCoverage | null> {
  let json: Record<string, IstanbulFileCoverage>;
  try {
    json = JSON.parse(await readFile(path.join(reportsDir, "coverage-final.json"), "utf8"));
  } catch {
    return null;
  }
  const norm = (p: string) => p.split(path.sep).join("/");
  const suffix = norm(targetRelative);
  const key = Object.keys(json).find((k) => norm(k).endsWith("/" + suffix) || norm(k) === suffix);
  if (!key) return null;
  const counts = json[key].s;
  if (!counts) return null;
  const values = Object.values(counts);
  return {
    totalStatements: values.length,
    executedStatements: values.filter((n) => n > 0).length,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class VitestTestRunner implements TestRunner {
  private readonly projectRoot: string;
  private readonly targetFilePath: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: TestRunnerOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.targetFilePath = path.resolve(options.targetFilePath);
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  run(position: Position, relevantTestFile: string, options?: { timeoutMs?: number }): Promise<TestOutcome> {
    return this.execute(position, relevantTestFile, false, options?.timeoutMs).then((r) => r.outcome);
  }

  runWithCoverage(
    position: Position,
    relevantTestFile: string,
    options?: { timeoutMs?: number },
  ): Promise<CoverageRunResult> {
    return this.execute(position, relevantTestFile, true, options?.timeoutMs);
  }

  private async execute(
    position: Position,
    relevantTestFile: string,
    withCoverage: boolean,
    timeoutOverride?: number,
  ): Promise<CoverageRunResult> {
    const timeoutMs = timeoutOverride ?? this.defaultTimeoutMs;
    let tempRoot: string | undefined;
    let vitest: VitestLike | undefined;
    let timer: NodeJS.Timeout | undefined;
    const savedExitCode = process.exitCode;
    try {
      tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), "refactor-fish-")));
      await mirror(this.projectRoot, tempRoot);

      const nodeModules = findNodeModules(this.projectRoot);
      if (nodeModules && !existsSync(path.join(tempRoot, "node_modules"))) {
        await symlink(nodeModules, path.join(tempRoot, "node_modules"), "dir");
      }

      const targetRel = path.relative(this.projectRoot, this.targetFilePath);
      const testRel = path.relative(this.projectRoot, path.resolve(relevantTestFile));
      if (targetRel.startsWith("..") || testRel.startsWith("..")) {
        return { outcome: { kind: "error", message: "Target or test file is outside the project root." }, coverage: null };
      }
      // Only the temp copy is written.
      const tempTarget = path.join(tempRoot, targetRel);
      await mkdir(path.dirname(tempTarget), { recursive: true });
      await writeFile(tempTarget, position.sourceText, "utf8");

      const hasConfig = (await readdir(tempRoot)).some((n) => CONFIG_RE.test(n));
      const reportsDirectory = path.join(tempRoot, ".refactor-fish-coverage");

      const { createVitest } = await import("vitest/node");
      const cliOptions: Record<string, unknown> = {
        root: tempRoot,
        watch: false,
        run: true,
        reporters: [],
        include: [testRel.split(path.sep).join("/")],
        passWithNoTests: false,
        ...(hasConfig ? {} : { config: false }),
        coverage: withCoverage
          ? {
              enabled: true,
              provider: "v8",
              reporter: ["json"],
              reportsDirectory,
              include: [targetRel.split(path.sep).join("/")],
              clean: true,
            }
          : { enabled: false },
      };
      const instance = (await createVitest(cliOptions as never)) as unknown as VitestLike;
      vitest = instance;

      const fileErrors: string[] = [];
      const runPromise = (async (): Promise<TestOutcome> => {
        try {
          const result = (await instance.start([testRel.split(path.sep).join("/")])) as
            | { unhandledErrors?: unknown[] }
            | undefined;
          return mapOutcome(instance, result?.unhandledErrors ?? [], fileErrors);
        } catch (e) {
          return { kind: "error", message: errorMessage(e) };
        }
      })();

      const TIMEOUT = Symbol("timeout");
      const outcome = await Promise.race([
        runPromise,
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);

      if (outcome === TIMEOUT) {
        await closeQuietly(instance);
        vitest = undefined;
        void runPromise.catch(() => undefined);
        return { outcome: { kind: "timeout" }, coverage: null };
      }

      let coverage: RawCoverage | null = null;
      if (withCoverage) {
        await closeQuietly(instance); // flushes coverage reports
        vitest = undefined;
        coverage = await readRawCoverage(reportsDirectory, targetRel);
      }
      return { outcome, coverage };
    } catch (e) {
      return { outcome: { kind: "error", message: errorMessage(e) }, coverage: null };
    } finally {
      if (timer) clearTimeout(timer);
      if (vitest) await closeQuietly(vitest);
      process.exitCode = savedExitCode;
      if (tempRoot) {
        // Remove the symlink first so rm never follows into the real node_modules.
        await rm(path.join(tempRoot, "node_modules"), { force: true }).catch(() => undefined);
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

async function closeQuietly(v: VitestLike): Promise<void> {
  await Promise.race([
    v.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
  ]);
}

/** Returns true when `p` exists and is a regular file (small helper for callers). */
export async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
