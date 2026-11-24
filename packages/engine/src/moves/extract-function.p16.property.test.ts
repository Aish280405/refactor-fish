// Feature: refactor-fish, Property 16: For any Position and any eligible Extract_Function candidate, applying it SHALL create a new function with exactly one parameter per distinct outer variable the sequence reads, ordered by first read, and SHALL replace the sequence with a call passing each of those variables as an argument in the same order.
import fc from "fast-check";
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { Position } from "../types.js";
import { generateExtractFunctionCandidates } from "./extract-function.js";

/**
 * **Validates: Requirements 8.2**
 *
 * Generated shape:
 *
 *   function f(p0: number, ...) {
 *     let l0 = 1, ...;
 *     {
 *       <>= 5 statements over p*, l* and block-local temps t*>
 *     }
 *     return p0 + ... + l0 + ...;
 *   }
 *
 * The outer block has at most 3 statements, so the inner block is the only
 * extraction site and its whole statement list is the extracted sequence.
 *
 * Expected parameters: every outer variable the sequence reads (`+=` counts as
 * a read), plus the documented case of a variable written only inside an
 * `if` and never read. A variable that is never read and is overwritten by a
 * top-level `x = ...` statement is not a parameter. Read variables must appear
 * in order of first read.
 */

type Operand = { kind: "var"; i: number } | { kind: "temp"; i: number } | { kind: "lit"; n: number };
type Stmt =
  | { kind: "decl"; expr: Operand[] }
  | { kind: "assign"; target: number; expr: Operand[] }
  | { kind: "compound"; target: number; expr: Operand[] }
  | { kind: "cond"; test: number; target: number; expr: Operand[] };

const arbOperand: fc.Arbitrary<Operand> = fc.oneof(
  { weight: 4, arbitrary: fc.nat(5).map((i) => ({ kind: "var" as const, i })) },
  { weight: 2, arbitrary: fc.nat(5).map((i) => ({ kind: "temp" as const, i })) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 9 }).map((n) => ({ kind: "lit" as const, n })) },
);
const arbExpr = fc.array(arbOperand, { minLength: 1, maxLength: 3 });
const arbStmt: fc.Arbitrary<Stmt> = fc.oneof(
  { weight: 3, arbitrary: arbExpr.map((expr) => ({ kind: "decl" as const, expr })) },
  {
    weight: 3,
    arbitrary: fc
      .record({ target: fc.nat(5), expr: arbExpr })
      .map((r) => ({ kind: "assign" as const, ...r })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ target: fc.nat(5), expr: arbExpr })
      .map((r) => ({ kind: "compound" as const, ...r })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ test: fc.nat(5), target: fc.nat(5), expr: arbExpr })
      .map((r) => ({ kind: "cond" as const, ...r })),
  },
);

const arbCase = fc.record({
  nParams: fc.integer({ min: 1, max: 3 }),
  nLocals: fc.integer({ min: 0, max: 2 }),
  stmts: fc.array(arbStmt, { minLength: 5, maxLength: 8 }),
});

interface Built {
  source: string;
  /** Expected parameter set. */
  expectedSet: string[];
  /** Read variables in order of first read. */
  readOrder: string[];
  /** Expected full parameter order: read vars by first read, then write-only vars by first write. */
  expectedOrder: string[];
}

function build(c: { nParams: number; nLocals: number; stmts: Stmt[] }): Built {
  const vars = [
    ...Array.from({ length: c.nParams }, (_, i) => `p${i}`),
    ...Array.from({ length: c.nLocals }, (_, i) => `l${i}`),
  ];
  const v = (i: number) => vars[i % vars.length];
  const readOrder: string[] = [];
  const condWritten = new Set<string>();
  const topWritten = new Set<string>();
  const writeOrder: string[] = [];
  const read = (name: string) => {
    if (!readOrder.includes(name)) readOrder.push(name);
  };
  const write = (name: string) => {
    if (!writeOrder.includes(name)) writeOrder.push(name);
  };
  let temps = 0;
  const renderExpr = (ops: Operand[]): string =>
    ops
      .map((o) => {
        if (o.kind === "var") {
          read(v(o.i));
          return v(o.i);
        }
        if (o.kind === "temp" && temps > 0) return `t${o.i % temps}`;
        return String(o.kind === "lit" ? o.n : 1);
      })
      .join(" + ");

  const lines: string[] = [];
  for (const s of c.stmts) {
    switch (s.kind) {
      case "decl": {
        const e = renderExpr(s.expr);
        lines.push(`const t${temps++} = ${e};`);
        break;
      }
      case "assign": {
        const t = v(s.target);
        topWritten.add(t);
        write(t);
        lines.push(`${t} = ${renderExpr(s.expr)};`);
        break;
      }
      case "compound": {
        const t = v(s.target);
        read(t);
        lines.push(`${t} += ${renderExpr(s.expr)};`);
        break;
      }
      case "cond": {
        const test = v(s.test);
        read(test);
        const t = v(s.target);
        condWritten.add(t);
        write(t);
        lines.push(`if (${test} > 0) { ${t} = ${renderExpr(s.expr)}; }`);
        break;
      }
    }
  }
  const expectedSet = vars.filter(
    (x) => readOrder.includes(x) || (condWritten.has(x) && !topWritten.has(x)),
  );
  const writeOnly = writeOrder.filter((x) => expectedSet.includes(x) && !readOrder.includes(x));
  const expectedOrder = [...readOrder, ...writeOnly];

  const params = vars.filter((x) => x.startsWith("p")).map((x) => `${x}: number`);
  const locals = vars.filter((x) => x.startsWith("l"));
  const source =
    `export function f(${params.join(", ")}) {\n` +
    (locals.length > 0 ? `  let ${locals.map((l, i) => `${l} = ${i + 1}`).join(", ")};\n` : "") +
    "  {\n" +
    lines.map((l) => `    ${l}\n`).join("") +
    "  }\n" +
    `  return ${vars.join(" + ")};\n` +
    "}\n";
  return { source, expectedSet, readOrder, expectedOrder };
}

const isCallTo = (e: ts.Expression, name: string): e is ts.CallExpression =>
  ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === name;

describe("Property 16: Extract_Function call-site wiring correctness", () => {
  it(
    "creates one parameter per read outer variable in first-read order and calls it with matching arguments",
    () => {
      fc.assert(
        fc.property(arbCase, (c) => {
          const { source, expectedSet, readOrder, expectedOrder } = build(c);
          const position: Position = { sourceText: source, filePath: "target.ts" };
          const cands = generateExtractFunctionCandidates(position);
          expect(cands).toHaveLength(1);
          const res = cands[0].apply(position);
          expect(res.ok).toBe(true);
          const out = res.resultingSource!;
          const sf = ts.createSourceFile("out.ts", out, ts.ScriptTarget.Latest, true);

          // The new function exists at top level.
          const fns = sf.statements.filter(ts.isFunctionDeclaration);
          const f = fns.find((d) => d.name?.text === "f")!;
          const extracted = fns.filter((d) => d.name?.text !== "f");
          expect(extracted).toHaveLength(1);
          const name = extracted[0].name!.text;
          const paramNames = extracted[0].parameters.map((p) => (p.name as ts.Identifier).text);

          // Exactly one parameter per expected variable.
          expect([...paramNames].sort()).toEqual([...expectedSet].sort());
          expect(new Set(paramNames).size).toBe(paramNames.length);
          // Read variables keep first-read order.
          expect(paramNames.filter((p) => readOrder.includes(p))).toEqual(readOrder);
          // Read variables come first, then write-only variables by first write.
          expect(paramNames).toEqual(expectedOrder);

          // The sequence is replaced by the call (plus result wiring) only.
          const inner = f.body!.statements.find(ts.isBlock)!;
          const calls: ts.CallExpression[] = [];
          let resultVar: string | undefined;
          for (const st of inner.statements) {
            if (ts.isExpressionStatement(st)) {
              const e = st.expression;
              if (isCallTo(e, name)) {
                calls.push(e);
                continue;
              }
              expect(ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken).toBe(true);
              const b = e as ts.BinaryExpression;
              expect(ts.isIdentifier(b.left)).toBe(true);
              if (isCallTo(b.right, name)) {
                calls.push(b.right);
                continue;
              }
              // `x = extractedResult.x`
              expect(ts.isPropertyAccessExpression(b.right)).toBe(true);
              const pa = b.right as ts.PropertyAccessExpression;
              expect(ts.isIdentifier(pa.expression) && pa.expression.text === resultVar).toBe(true);
              expect(pa.name.text).toBe((b.left as ts.Identifier).text);
            } else {
              expect(ts.isVariableStatement(st)).toBe(true);
              const decls = (st as ts.VariableStatement).declarationList.declarations;
              expect(decls).toHaveLength(1);
              const init = decls[0].initializer;
              expect(init !== undefined && isCallTo(init, name)).toBe(true);
              resultVar = (decls[0].name as ts.Identifier).text;
              calls.push(init as ts.CallExpression);
            }
          }
          expect(calls).toHaveLength(1);
          const args = calls[0].arguments.map((a) => (ts.isIdentifier(a) ? a.text : a.getText(sf)));
          expect(args).toEqual(paramNames);
        }),
        { numRuns: 100 },
      );
    },
    300_000,
  );
});
