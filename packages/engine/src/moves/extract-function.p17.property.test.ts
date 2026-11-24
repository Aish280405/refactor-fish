// Feature: refactor-fish, Property 17: For any Position and any eligible Extract_Function candidate where the sequence assigns to one or more outer variables or ends in a value-yielding `return`, applying the Move SHALL cause each such outer variable to hold, immediately after the call site, the same value it would have held had the original sequence executed in place (verified by executing both the pre- and post-extraction Position against an interpreter/test harness with equivalent instrumented inputs).
import fc from "fast-check";
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { generateExtractFunctionCandidates } from "./extract-function.js";

/**
 * Generated shape (pure, no I/O):
 *
 *   function f(p0: number, ..., c0: boolean) {
 *     let l0 = <n>; ...          // outer `let` locals
 *     {                          // the only block with >= 5 statements
 *       <statements reading/assigning p*, l*, and block-local temps>
 *       [return [<expr>, p0, ..., l0, ...];]   // optional value-yielding final return
 *     }
 *     return [p0, ..., l0, ...]; // snapshot of every outer variable (mode without final return)
 *   }
 *
 * The function body itself has at most 4 statements, so the inner block is the
 * only extraction site. Both versions are transpiled to JS, run with the same
 * inputs, and the returned snapshots must be identical.
 */

type Atom = { kind: "var"; idx: number } | { kind: "lit"; v: number };
type Expr = { a: Atom; rest?: { op: "+" | "-" | "*"; b: Atom } };
type Cond =
  | { kind: "c0"; neg: boolean }
  | { kind: "gt"; a: Atom; b: Atom }
  | { kind: "even"; a: Atom };

type Stmt =
  | { k: "assign"; t: number; e: Expr }
  | { k: "compound"; t: number; op: "+=" | "-=" | "*="; e: Expr }
  | { k: "inc"; t: number; dec: boolean }
  | { k: "if"; cond: Cond; t: number; e: Expr; braces: boolean; els?: { t: number; e: Expr } }
  | { k: "const"; e: Expr }
  | { k: "loop"; n: number; t: number; e: Expr }
  | { k: "swap"; a: number; b: number };

interface Shape {
  paramCount: number;
  localInits: number[];
  stmts: Stmt[];
  finalReturn?: Expr;
}

const arbAtom: fc.Arbitrary<Atom> = fc.oneof(
  { weight: 3, arbitrary: fc.nat({ max: 20 }).map((idx) => ({ kind: "var" as const, idx })) },
  { weight: 1, arbitrary: fc.integer({ min: -3, max: 5 }).map((v) => ({ kind: "lit" as const, v })) },
);
const arbExpr: fc.Arbitrary<Expr> = fc.record(
  {
    a: arbAtom,
    rest: fc.record({ op: fc.constantFrom("+" as const, "-" as const, "*" as const), b: arbAtom }),
  },
  { requiredKeys: ["a"] },
);
const arbCond: fc.Arbitrary<Cond> = fc.oneof(
  fc.record({ kind: fc.constant("c0" as const), neg: fc.boolean() }),
  fc.record({ kind: fc.constant("gt" as const), a: arbAtom, b: arbAtom }),
  fc.record({ kind: fc.constant("even" as const), a: arbAtom }),
);
const arbTarget = fc.nat({ max: 20 });

const arbStmt: fc.Arbitrary<Stmt> = fc.oneof(
  fc.record({ k: fc.constant("assign" as const), t: arbTarget, e: arbExpr }),
  fc.record({
    k: fc.constant("compound" as const),
    t: arbTarget,
    op: fc.constantFrom("+=" as const, "-=" as const, "*=" as const),
    e: arbExpr,
  }),
  fc.record({ k: fc.constant("inc" as const), t: arbTarget, dec: fc.boolean() }),
  fc.record(
    {
      k: fc.constant("if" as const),
      cond: arbCond,
      t: arbTarget,
      e: arbExpr,
      braces: fc.boolean(),
      els: fc.record({ t: arbTarget, e: arbExpr }),
    },
    { requiredKeys: ["k", "cond", "t", "e", "braces"] },
  ),
  fc.record({ k: fc.constant("const" as const), e: arbExpr }),
  fc.record({ k: fc.constant("loop" as const), n: fc.integer({ min: 0, max: 3 }), t: arbTarget, e: arbExpr }),
  fc.record({ k: fc.constant("swap" as const), a: arbTarget, b: arbTarget }),
);

const arbShape: fc.Arbitrary<Shape> = fc.record(
  {
    paramCount: fc.integer({ min: 1, max: 3 }),
    localInits: fc.array(fc.integer({ min: -5, max: 9 }), { minLength: 1, maxLength: 2 }),
    stmts: fc.array(arbStmt, { minLength: 5, maxLength: 9 }),
    finalReturn: arbExpr,
  },
  { requiredKeys: ["paramCount", "localInits", "stmts"] },
);

function build(shape: Shape): { source: string; paramCount: number } {
  const params = Array.from({ length: shape.paramCount }, (_, i) => `p${i}`);
  const locals = shape.localInits.map((_, i) => `l${i}`);
  const outer = [...params, ...locals];
  const temps: string[] = [];

  const readable = (extra: string[] = []) => [...outer, ...temps, ...extra];
  const atom = (a: Atom, extra: string[] = []): string => {
    if (a.kind === "lit") return a.v < 0 ? `(${a.v})` : String(a.v);
    const r = readable(extra);
    return r[a.idx % r.length]!;
  };
  const expr = (e: Expr, extra: string[] = []): string =>
    e.rest ? `${atom(e.a, extra)} ${e.rest.op} ${atom(e.rest.b, extra)}` : atom(e.a, extra);
  const target = (t: number) => outer[t % outer.length]!;
  const cond = (c: Cond): string => {
    if (c.kind === "c0") return c.neg ? "!c0" : "c0";
    if (c.kind === "gt") return `${atom(c.a)} > ${atom(c.b)}`;
    return `${atom(c.a)} % 2 === 0`;
  };

  const lines: string[] = [];
  let loopIdx = 0;
  for (const s of shape.stmts) {
    switch (s.k) {
      case "assign":
        lines.push(`${target(s.t)} = ${expr(s.e)};`);
        break;
      case "compound":
        lines.push(`${target(s.t)} ${s.op} ${expr(s.e)};`);
        break;
      case "inc":
        lines.push(`${target(s.t)}${s.dec ? "--" : "++"};`);
        break;
      case "if": {
        const thenS = `${target(s.t)} = ${expr(s.e)};`;
        let text = s.braces ? `if (${cond(s.cond)}) { ${thenS} }` : `if (${cond(s.cond)}) ${thenS}`;
        if (s.els) text += ` else { ${target(s.els.t)} += ${expr(s.els.e)}; }`;
        lines.push(text);
        break;
      }
      case "const": {
        const name = `t${temps.length}`;
        lines.push(`const ${name} = ${expr(s.e)};`);
        temps.push(name);
        break;
      }
      case "loop": {
        const i = `i${loopIdx++}`;
        lines.push(`for (let ${i} = 0; ${i} < ${s.n}; ${i}++) ${target(s.t)} += ${expr(s.e, [i])};`);
        break;
      }
      case "swap": {
        const a = target(s.a);
        let b = target(s.b);
        if (a === b) b = outer[(outer.indexOf(a) + 1) % outer.length]!;
        lines.push(a === b ? `${a} = ${a};` : `[${a}, ${b}] = [${b}, ${a}];`);
        break;
      }
    }
  }
  const snapshot = `[${outer.join(", ")}]`;
  if (shape.finalReturn) lines.push(`return [${expr(shape.finalReturn)}, ${outer.join(", ")}];`);

  const sig = [...params.map((p) => `${p}: number`), "c0: boolean"].join(", ");
  const body = [
    ...locals.map((l, i) => `  let ${l} = ${shape.localInits[i]};`),
    "  {",
    ...lines.map((l) => `    ${l}`),
    "  }",
    ...(shape.finalReturn ? [] : [`  return ${snapshot};`]),
  ];
  return { source: `function f(${sig}) {\n${body.join("\n")}\n}\n`, paramCount: shape.paramCount };
}

type Fn = (...args: unknown[]) => unknown;

function compile(source: string): Fn {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  // The program is pure arithmetic over its arguments; no globals are referenced.
  return new Function(`"use strict";\n${js}\nreturn f;`)() as Fn;
}

const arbInputs = fc.array(
  fc.record({
    nums: fc.array(fc.integer({ min: -10, max: 10 }), { minLength: 3, maxLength: 3 }),
    c0: fc.boolean(),
  }),
  { minLength: 1, maxLength: 4 },
);

describe("Property 17: Extract_Function value propagation preservation", () => {
  /** **Validates: Requirements 8.3** */
  it("outer variables and the yielded value match in-place execution", () => {
    fc.assert(
      fc.property(arbShape.map(build), arbInputs, ({ source, paramCount }, inputs) => {
        const position = { sourceText: source, filePath: "target.ts" };
        const candidates = generateExtractFunctionCandidates(position);
        expect(candidates, source).toHaveLength(1);

        const result = candidates[0]!.apply(position);
        expect(result.ok, `${result.error?.reason ?? ""}\n${source}`).toBe(true);
        const after = result.resultingSource!;
        expect(after).not.toBe(source);

        const before = compile(source);
        const extracted = compile(after);
        for (const { nums, c0 } of inputs) {
          const args = [...nums.slice(0, paramCount), c0];
          expect(extracted(...args), `input ${JSON.stringify(args)}\n--- before\n${source}\n--- after\n${after}`).toEqual(
            before(...args),
          );
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
