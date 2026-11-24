import { describe, expect, it } from "vitest";
import type { Candidate, GeneratorContext, MoveKind } from "../types.js";
import { DETERMINISTIC_CATALOG, DeterministicMoveGenerator } from "./deterministic-move-generator.js";
import { generateExtractFunctionCandidates } from "./extract-function.js";
import { generateGuardClauseCandidates } from "./guard-clause.js";
import { generateInlineVariable } from "./inline-variable.js";
import { generateRemoveUnused } from "./remove-unused.js";
import { generateSimplifyBoolean } from "./simplify-boolean.js";

const pos = (sourceText: string) => ({ sourceText, filePath: "target.ts" });
const ctx = (): GeneratorContext => ({ discardLog: [] });

const CATALOG_ORDER: MoveKind[] = [
  "RemoveUnused",
  "InlineVariable",
  "GuardClause",
  "SimplifyBoolean",
  "ExtractFunction",
];

const src = [
  `import { unusedImport } from "x";`,
  `const unusedVar = 1;`,
  `export function check(flag: boolean, n: number): number {`,
  `  const doubled = n * 2;`,
  `  if (flag === true) {`,
  `    const a = doubled + 1;`,
  `    const b = a + 1;`,
  `    const c = b + 1;`,
  `    const d = c + 1;`,
  `    const e = d + 1;`,
  `    return e;`,
  `  }`,
  `  return 0;`,
  `}`,
  ``,
].join("\n");

const summarize = (cs: Candidate[]) => cs.map((c) => `${c.move}:${c.describe()}`);

describe("DeterministicMoveGenerator", () => {
  it("uses the five sub-generators in catalog order", () => {
    expect(DETERMINISTIC_CATALOG.map((e) => e.kind)).toEqual(CATALOG_ORDER);
  });

  it("concatenates sub-generator output in catalog order, preserving each one's source order", async () => {
    const p = pos(src);
    const expected = [
      ...generateRemoveUnused(p),
      ...generateInlineVariable(p),
      ...generateGuardClauseCandidates(p),
      ...generateSimplifyBoolean(p),
      ...generateExtractFunctionCandidates(p),
    ];
    const actual = await new DeterministicMoveGenerator().generate(p, ctx());
    expect(summarize(actual)).toEqual(summarize(expected));

    // Kinds appear grouped and in catalog order.
    const kinds = actual.map((c) => CATALOG_ORDER.indexOf(c.move));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
    // The fixture exercises several kinds.
    expect(new Set(actual.map((c) => c.move)).size).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("returns the same ordered list on repeated calls and applies deterministically", async () => {
    const gen = new DeterministicMoveGenerator();
    const p = pos(src);
    const first = await gen.generate(p, ctx());
    for (let i = 0; i < 2; i++) {
      expect(summarize(await gen.generate(p, ctx()))).toEqual(summarize(first));
    }
    for (const c of first) {
      const r1 = c.apply(p);
      const r2 = c.apply(p);
      expect(r1).toEqual(r2);
      expect(p.sourceText).toBe(src);
    }
  }, 60_000);

  it("returns an empty list for a Position with no applicable moves", async () => {
    const out = await new DeterministicMoveGenerator().generate(pos(`export const x = 1;\n`), ctx());
    expect(out).toEqual([]);
  });

  it("isolates a throwing sub-generator and never lets apply throw", async () => {
    const throwingApply: Candidate = {
      move: "GuardClause",
      displayName: "Guard clause",
      describe: () => "boom",
      apply: () => {
        throw new Error("kaboom");
      },
    };
    const gen = new DeterministicMoveGenerator([
      { kind: "RemoveUnused", generate: () => { throw new Error("analysis failed"); } },
      { kind: "GuardClause", generate: () => [throwingApply] },
    ]);
    const out = await gen.generate(pos(src), ctx());
    expect(out.map((c) => c.describe())).toEqual(["boom"]);
    const r = out[0]!.apply(pos(src));
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toContain("kaboom");
  });
});
