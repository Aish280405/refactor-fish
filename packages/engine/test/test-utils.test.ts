import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import {
  FakeLLMProvider,
  FakeTestRunner,
  InMemoryFsSpy,
  arbitraryLine,
  arbitraryMetrics,
  arbitraryPosition,
  arbitraryRecording,
  arbitraryTestOutcome,
} from "../test-utils/index.js";

describe("test-utils arbitraries", () => {
  it("arbitraryPosition yields sources with no syntax errors", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    fc.assert(
      fc.property(arbitraryPosition(), (p) => {
        const sf = project.createSourceFile("t.ts", p.sourceText, { overwrite: true });
        expect(project.getProgram().getSyntacticDiagnostics(sf)).toHaveLength(0);
      }),
      { numRuns: 50 },
    );
  });

  it("arbitraryRecording survives a JSON round trip; edge cases can be forced", () => {
    fc.assert(
      fc.property(arbitraryRecording(), (r) => {
        expect(JSON.parse(JSON.stringify(r))).toEqual(r);
      }),
      { numRuns: 50 },
    );
    fc.assert(
      fc.property(arbitraryRecording({ noBlunders: true, emptyBestLine: true }), (r) => {
        expect(r.blunders).toEqual([]);
        expect(r.bestLine).toEqual([]);
      }),
      { numRuns: 10 },
    );
  });

  it("arbitraryLine indexes moves 1..n and chains them", () => {
    fc.assert(
      fc.property(arbitraryLine(), (line) => {
        line.moves.forEach((m, i) => {
          expect(m.index).toBe(i + 1);
          if (i > 0) expect(m.sourceBefore).toBe(line.moves[i - 1]!.sourceAfter);
        });
      }),
      { numRuns: 50 },
    );
  });

  it("metrics and outcomes have the expected shape", () => {
    fc.assert(fc.property(arbitraryMetrics(), (m) => Object.values(m).every((v) => Number.isInteger(v))), { numRuns: 20 });
    fc.assert(
      fc.property(arbitraryTestOutcome(), (o) => o.kind !== "failed" || o.failures.length > 0),
      { numRuns: 50 },
    );
  });

  it("the same seed generates the same inputs (Requirement 24.7)", () => {
    const sample = () => fc.sample(arbitraryPosition(), { seed: 42, numRuns: 10 });
    expect(sample()).toEqual(sample());
  });
});

describe("fakes", () => {
  const pos = { sourceText: "a", filePath: "t.ts" };

  it("FakeTestRunner returns configured outcomes and records calls", async () => {
    const runner = new FakeTestRunner({ outcomes: { a: { kind: "timeout" } } });
    expect(await runner.run(pos, "t.test.ts")).toEqual({ kind: "timeout" });
    expect(await runner.run({ ...pos, sourceText: "b" }, "t.test.ts")).toEqual({ kind: "passed" });
    expect(runner.callCount).toBe(2);
    expect(runner.runSources).toEqual(["a", "b"]);
  });

  it("FakeLLMProvider returns proposals, records requests, and can fail", async () => {
    const ok = new FakeLLMProvider({ proposals: [{ title: "t", resultingSource: "x" }] });
    expect(await ok.proposeMoves(pos, 5, 30000)).toHaveLength(1);
    expect(ok.payloads).toEqual(["a"]);
    const bad = new FakeLLMProvider({ failWith: new Error("boom") });
    await expect(bad.proposeMoves(pos, 5, 30000)).rejects.toThrow("boom");
  });

  it("InMemoryFsSpy records mutations and simulates write failure", () => {
    const fs = new InMemoryFsSpy({ "/p/target.ts": "orig" });
    fs.writeFile("/tmp/x/a.ts", "c");
    fs.rename("/tmp/x/a.ts", "/tmp/x/b.ts");
    expect(fs.writesOutside("/tmp/")).toEqual([]);
    fs.failNextWrite();
    expect(() => fs.writeFile("/p/target.ts", "new")).toThrow();
    expect(fs.readFile("/p/target.ts")).toBe("orig");
    expect(fs.writesOutside("/tmp/")).toEqual(["/p/target.ts"]);
  });
});
