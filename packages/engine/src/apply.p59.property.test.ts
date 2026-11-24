// Feature: refactor-fish, Property 59: Apply disk-freshness guard
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, type ApplyFileSystem } from "./apply.js";
import type { MoveRecord } from "./recording.js";
import type { TestRunner } from "./test-runner.js";
import type { Metrics, Position, TestOutcome } from "./types.js";

const M: Metrics = {
  cyclomaticComplexity: 0,
  maxNestingDepth: 0,
  functionLength: 0,
  duplicatedCode: 0,
  unusedCode: 0,
};

const TARGET = "/proj/target.ts";
const NEW_SOURCE = "// refactored\n";

const move: MoveRecord = {
  index: 0,
  kind: "RemoveUnused",
  displayName: "m",
  description: "d",
  annotation: "!",
  sourceBefore: "",
  sourceAfter: NEW_SOURCE,
  metricsBefore: M,
  metricsAfter: M,
  scoreBefore: 0,
  scoreAfter: 0,
};

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
    this.files.set(b, this.files.get(a)!);
    this.files.delete(a);
  }
  async rm(p: string): Promise<void> {
    this.files.delete(p);
  }
}

class SpyRunner implements TestRunner {
  calls: Position[] = [];
  async run(position: Position): Promise<TestOutcome> {
    this.calls.push(position);
    return { kind: "passed" };
  }
  async runWithCoverage(): Promise<never> {
    throw new Error("unused");
  }
}

/** Disk content derived from the original: equal, or differing by a small, easy-to-miss edit. */
function diskFor(original: string): fc.Arbitrary<string> {
  const variants: fc.Arbitrary<string>[] = [
    fc.constant(original),
    fc.constant(original + "\n"),
    fc.constant(original.replace(/\n/g, "\r\n")),
    fc.constant(original.endsWith("\n") ? original.slice(0, -1) : original + " "),
    fc.string(),
  ];
  if (original.length > 0) {
    variants.push(
      fc
        .tuple(fc.nat({ max: original.length - 1 }), fc.string({ minLength: 1, maxLength: 1 }))
        .map(([i, ch]) => original.slice(0, i) + ch + original.slice(i + 1)),
    );
  }
  return fc.oneof(...variants);
}

const originalArb = fc.oneof(
  fc.string(),
  fc.array(fc.string(), { maxLength: 5 }).map((lines) => lines.join("\n") + "\n"),
);

describe("applyChanges", () => {
  it("Property 59: proceeds iff disk content is byte-for-byte equal to the original Position", async () => {
    /** Validates: Requirements 21.5 */
    await fc.assert(
      fc.asyncProperty(
        originalArb.chain((original) => fc.tuple(fc.constant(original), diskFor(original))),
        async ([original, disk]) => {
          const fs = new SpyFs();
          fs.files.set(TARGET, disk);
          const runner = new SpyRunner();
          const r = await applyChanges({
            targetFilePath: TARGET,
            originalSource: original,
            bestLine: [move],
            selection: { kind: "best-line" },
            relevantTestFile: "/proj/target.test.ts",
            testRunner: runner,
            fs,
          });
          if (disk === original) {
            expect(runner.calls).toHaveLength(1);
            expect(r.kind).toBe("applied");
            expect(fs.files.get(TARGET)).toBe(NEW_SOURCE);
          } else {
            expect(r.kind).toBe("file-changed");
            expect(runner.calls).toHaveLength(0);
            expect(fs.writes).toBe(0);
            expect(fs.renames).toBe(0);
            expect([...fs.files.entries()]).toEqual([[TARGET, disk]]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
