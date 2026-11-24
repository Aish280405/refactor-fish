// Feature: refactor-fish, Property 11: Inline_Variable substitution correctness
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Project, SyntaxKind } from "ts-morph";
import { parsesCleanly } from "../ast-editor.js";
import type { Position } from "../types.js";
import { generateInlineVariable } from "./inline-variable.js";

/**
 * For any Position and any eligible Inline_Variable candidate, applying it SHALL
 * replace the single reference with the initializer expression (parenthesized
 * when required to preserve the initializer's operator precedence in its new
 * context), expand a shorthand property reference `{ x }` to
 * `{ x: <initializer> }` where applicable, remove only the inlined declarator
 * from its declaration statement, and produce a Position that parses as valid
 * TypeScript.
 *
 * The generator builds a pure expression `I` (arithmetic, comparison, logical,
 * `??`, unary, ternary) and a context expression `C` with exactly one hole, then
 * renders
 *
 *   function f(a, b, c, d) { const [u = 1,] t = I[, w = 2]; return C[t]; }
 *
 * (or `return { t };` for the shorthand case) with minimal parentheses. Because
 * every expression is pure, the oracle is evaluation: the function before and
 * after the Move must return the same value for every input.
 *
 * **Validates: Requirements 5.2**
 */

type Op = "+" | "-" | "*" | "/" | "%" | "**" | "<" | "===" | "&&" | "||" | "??";

type Expr =
  | { k: "var"; n: "a" | "b" | "c" | "d" }
  | { k: "lit"; v: number }
  | { k: "hole" }
  | { k: "neg"; e: Expr }
  | { k: "not"; e: Expr }
  | { k: "method"; e: Expr } // e.valueOf()
  | { k: "bin"; op: Op; l: Expr; r: Expr }
  | { k: "cond"; c: Expr; t: Expr; f: Expr };

const OPS: Op[] = ["+", "-", "*", "/", "%", "**", "<", "===", "&&", "||", "??"];

function opPrec(op: Op): number {
  switch (op) {
    case "??":
    case "||":
      return 4;
    case "&&":
      return 5;
    case "===":
      return 9;
    case "<":
      return 10;
    case "+":
    case "-":
      return 12;
    case "*":
    case "/":
    case "%":
      return 13;
    case "**":
      return 14;
  }
}

function prec(e: Expr): number {
  switch (e.k) {
    case "neg":
    case "not":
      return 15;
    case "bin":
      return opPrec(e.op);
    case "cond":
      return 3;
    default:
      return 18;
  }
}

const isLogical = (e: Expr): boolean => e.k === "bin" && (e.op === "&&" || e.op === "||");
const isNullish = (e: Expr): boolean => e.k === "bin" && e.op === "??";

/** Prints `e` with only the parentheses JavaScript grammar requires. */
function print(e: Expr): string {
  const wrap = (x: Expr, need: boolean) => (need ? `(${print(x)})` : print(x));
  switch (e.k) {
    case "var":
      return e.n;
    case "lit":
      return String(e.v);
    case "hole":
      return "t";
    case "neg":
      return `-${wrap(e.e, prec(e.e) < 15 || e.e.k === "neg" || e.e.k === "not")}`;
    case "not":
      return `!${wrap(e.e, prec(e.e) < 15)}`;
    case "method":
      return `${wrap(e.e, prec(e.e) < 17 || e.e.k === "lit")}.valueOf()`;
    case "cond":
      return `${wrap(e.c, prec(e.c) < 4)} ? ${print(e.t)} : ${print(e.f)}`;
    case "bin": {
      const p = opPrec(e.op);
      const mix = (x: Expr) =>
        (e.op === "??" && isLogical(x)) || ((e.op === "&&" || e.op === "||") && isNullish(x));
      const leftNeed = e.op === "**" ? prec(e.l) < 16 : prec(e.l) < p || mix(e.l);
      const rightNeed = e.op === "**" ? prec(e.r) < 14 : prec(e.r) <= p || mix(e.r);
      return `${wrap(e.l, leftNeed)} ${e.op} ${wrap(e.r, rightNeed)}`;
    }
  }
}

const leafArb: fc.Arbitrary<Expr> = fc.oneof(
  fc.constantFrom("a", "b", "c", "d").map((n) => ({ k: "var", n }) as Expr),
  fc.integer({ min: 0, max: 5 }).map((v) => ({ k: "lit", v }) as Expr),
);

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: "small", maxDepth: 3, withCrossShrink: true },
    leafArb,
    tie("e").map((e) => ({ k: "neg", e }) as Expr),
    tie("e").map((e) => ({ k: "not", e }) as Expr),
    // No general `.valueOf()` nodes: a call before the reference is a side effect
    // (Requirement 5.3) and would make the candidate ineligible. The hole itself
    // may still be `t.valueOf()` (see withHole).
    fc
      .record({ op: fc.constantFrom(...OPS), l: tie("e"), r: tie("e") })
      .map((x) => ({ k: "bin", ...x }) as Expr),
    fc.record({ c: tie("e"), t: tie("e"), f: tie("e") }).map((x) => ({ k: "cond", ...x }) as Expr),
  ),
})).e;

function countLeaves(e: Expr): number {
  switch (e.k) {
    case "var":
    case "lit":
    case "hole":
      return 1;
    case "neg":
    case "not":
    case "method":
      return countLeaves(e.e);
    case "bin":
      return countLeaves(e.l) + countLeaves(e.r);
    case "cond":
      return countLeaves(e.c) + countLeaves(e.t) + countLeaves(e.f);
  }
}

/** Replaces the `idx`-th leaf (in source order) with the hole, optionally as `t.valueOf()`. */
function withHole(e: Expr, idx: number, asMethod: boolean): Expr {
  let i = 0;
  const go = (x: Expr): Expr => {
    switch (x.k) {
      case "var":
      case "lit":
      case "hole": {
        const mine = i++ === idx;
        if (!mine) return x;
        return asMethod ? { k: "method", e: { k: "hole" } } : { k: "hole" };
      }
      case "neg":
      case "not":
      case "method":
        return { ...x, e: go(x.e) };
      case "bin": {
        const l = go(x.l);
        return { ...x, l, r: go(x.r) };
      }
      case "cond": {
        const c = go(x.c);
        const t = go(x.t);
        return { ...x, c, t, f: go(x.f) };
      }
    }
  };
  return go(e);
}

interface Case {
  init: Expr;
  /** Context containing exactly one hole, or "shorthand" for `return { t };`. */
  context: Expr | "shorthand";
  before: boolean; // `u = 1,` declared before t in the same statement
  after: boolean; // `, w = 2` declared after t in the same statement
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  init: exprArb,
  context: fc.oneof(
    { weight: 1, arbitrary: fc.constant("shorthand" as const) },
    {
      weight: 5,
      arbitrary: exprArb.chain((ctx) =>
        fc
          .record({ idx: fc.nat({ max: countLeaves(ctx) - 1 }), asMethod: fc.boolean() })
          .map(({ idx, asMethod }) => withHole(ctx, idx, asMethod)),
      ),
    },
  ),
  before: fc.boolean(),
  after: fc.boolean(),
});

function render(c: Case): string {
  const decls = [...(c.before ? ["u = 1"] : []), `t = ${print(c.init)}`, ...(c.after ? ["w = 2"] : [])];
  const ret = c.context === "shorthand" ? "{ t }" : print(c.context);
  return `function f(a, b, c, d) {\n  const ${decls.join(", ")};\n  return ${ret};\n}\n`;
}

type Input = [number, number, boolean, boolean];
const inputsArb = fc.array(
  fc.tuple(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 }), fc.boolean(), fc.boolean()),
  { minLength: 3, maxLength: 3 },
);

function run(source: string, shorthand: boolean, inputs: Input[]): unknown[] {
  const f = new Function(`${source}\nreturn f;`)() as (...args: Input) => unknown;
  return inputs.map((args) => {
    const out = f(...args);
    return shorthand ? (out as { t: unknown }).t : out;
  });
}

const checkProject = new Project({ useInMemoryFileSystem: true });

describe("Property 11: Inline_Variable substitution correctness", () => {
  it("inlining preserves the value, expands shorthand, removes only the inlined declarator, and parses", () => {
    fc.assert(
      fc.property(caseArb, inputsArb, (c, inputs) => {
        const source = render(c);
        const shorthand = c.context === "shorthand";
        const position: Position = { sourceText: source, filePath: "target.ts" };
        const candidate = generateInlineVariable(position).find(
          (x) => x.describe() === "Inline variable 't'",
        );
        expect(candidate, `no candidate for 't' in:\n${source}`).toBeDefined();
        const result = candidate!.apply(position);
        expect(result.ok, `apply failed (${result.error?.reason}) on:\n${source}`).toBe(true);
        const out = result.resultingSource!;
        const msg = `before:\n${source}\nafter:\n${out}`;

        // Parses as valid TypeScript.
        expect(parsesCleanly(out), msg).toBe(true);

        // Only the inlined declarator is removed; the others keep their text and order.
        const sf = checkProject.createSourceFile("result.ts", out, { overwrite: true });
        const remaining = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).map((d) => d.getText());
        expect(remaining, msg).toEqual([...(c.before ? ["u = 1"] : []), ...(c.after ? ["w = 2"] : [])]);

        // `t` survives only as a shorthand-expanded property name `t: <init>`.
        const tIds = sf.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => id.getText() === "t");
        if (shorthand) {
          expect(tIds, msg).toHaveLength(1);
          const prop = tIds[0]!.getParentIfKind(SyntaxKind.PropertyAssignment);
          expect(prop, msg).toBeDefined();
          expect(prop!.getNameNode(), msg).toBe(tIds[0]);
          const init = prop!.getInitializerOrThrow().getText();
          expect([print(c.init), `(${print(c.init)})`], msg).toContain(init);
        } else {
          expect(tIds, msg).toHaveLength(0);
        }

        // The initializer text appears verbatim (possibly parenthesized) at the reference.
        expect(out.includes(print(c.init)), msg).toBe(true);

        // Precedence is preserved: same values for every input.
        const expected = run(source, shorthand, inputs);
        const actual = run(out, shorthand, inputs);
        for (let i = 0; i < inputs.length; i++) {
          expect(Object.is(actual[i], expected[i]), `${msg}\ninput ${JSON.stringify(inputs[i])}: ${String(actual[i])} vs ${String(expected[i])}`).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
