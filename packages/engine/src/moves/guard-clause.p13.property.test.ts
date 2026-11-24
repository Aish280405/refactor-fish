// Feature: refactor-fish, Property 13: For any Position and any eligible Guard_Clause candidate, applying it SHALL produce an `if` statement whose condition is the logical negation of the original condition and whose body is a single early return — a bare `return;` when the function's return type is void, and otherwise the expression of the following `return` statement, or `return undefined;` when none follows and `undefined` is part of the return type — followed by the original `if` body's statements unwrapped to the replaced `if` statement's nesting level.
import fc from "fast-check";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { Block, Statement } from "ts-morph";
import { describe, expect, it } from "vitest";
import { generateGuardClauseCandidates } from "./guard-clause.js";

/**
 * Documented implementation choices that preserve behavior and that this test allows:
 * - the early return is written single-line, `if (neg) return ...;`;
 * - negation may strip a leading `!` or wrap the condition in `!(...)`, so the
 *   condition is checked semantically over every boolean assignment of a, b, c;
 * - a following `return X;` is kept after the unwrapped body, except when the
 *   body already ends in `return`/`throw`, where it would be unreachable.
 */

const VARS = ["a", "b", "c"] as const;

// ---------- condition generator ----------

const arbCond: fc.Arbitrary<string> = fc.letrec<{ cond: string }>((tie) => ({
  cond: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom(...VARS),
    fc.constantFrom("true", "false"),
    tie("cond").map((x) => `!${x}`),
    tie("cond").map((x) => `!(${x})`),
    tie("cond").map((x) => `(${x})`),
    fc.tuple(tie("cond"), fc.constantFrom("&&", "||"), tie("cond")).map(([l, op, r]) => `${l} ${op} ${r}`),
  ),
})).cond;

// ---------- function generator ----------

type Ending = "none" | "return" | "throw";
type Trailing =
  | { kind: "none"; returnType: "void" | "number | undefined" | "undefined" }
  | { kind: "returnValue" }
  | { kind: "returnBare" };

interface Shape {
  fnKind: "function" | "arrow" | "method";
  async: boolean;
  prefixCount: number;
  cond: string;
  braces: boolean;
  singleLine: boolean;
  bodyKinds: ("call" | "decl" | "nestedIf")[];
  ending: Ending;
  trailing: Trailing;
}

const arbShape: fc.Arbitrary<Shape> = fc.record({
  fnKind: fc.constantFrom("function", "arrow", "method"),
  async: fc.boolean(),
  prefixCount: fc.integer({ min: 0, max: 2 }),
  cond: arbCond,
  braces: fc.boolean(),
  singleLine: fc.boolean(),
  bodyKinds: fc.array(fc.constantFrom("call", "decl", "nestedIf"), { maxLength: 4 }),
  ending: fc.constantFrom<Ending>("none", "return", "throw"),
  trailing: fc.oneof(
    fc.record({
      kind: fc.constant("none" as const),
      returnType: fc.constantFrom("void" as const, "number | undefined" as const, "undefined" as const),
    }),
    fc.constant({ kind: "returnValue" as const }),
    fc.constant({ kind: "returnBare" as const }),
  ),
});

interface Generated {
  source: string;
  shape: Shape;
  /** Original if-body statements, in order. */
  bodyStmts: string[];
  prefixStmts: string[];
  /** Trailing return statement text, if any. */
  trailingStmt?: string;
  /** Expected early-return expression text, or null for a bare `return;`. */
  expectedReturnExpr: string | null;
}

function build(shape: Shape): Generated {
  const returnTypeBase =
    shape.trailing.kind === "none"
      ? shape.trailing.returnType
      : shape.trailing.kind === "returnValue"
        ? "number"
        : "void";
  const returnType = shape.async ? `Promise<${returnTypeBase}>` : returnTypeBase;
  const isVoid = returnTypeBase === "void";

  const bodyStmts: string[] = shape.bodyKinds.map((k, i) => {
    if (k === "call") return `g(${i});`;
    if (k === "decl") return `const x${i} = ${i};`;
    return `if (b) { g(${i + 10}); }`;
  });
  if (shape.ending === "throw") bodyStmts.push(`throw new Error("e");`);
  if (shape.ending === "return") {
    bodyStmts.push(isVoid ? "return;" : returnTypeBase === "undefined" ? "return undefined;" : "return 2;");
  }
  // Without braces, the then-statement must be a single statement (and not a declaration).
  const braces = shape.braces || bodyStmts.length !== 1 || bodyStmts[0]!.startsWith("const ");

  const prefixStmts = Array.from({ length: shape.prefixCount }, (_, i) => `g(${100 + i});`);
  const trailingStmt =
    shape.trailing.kind === "returnValue" ? "return 7;" : shape.trailing.kind === "returnBare" ? "return;" : undefined;

  const ind = shape.fnKind === "method" ? "    " : "  ";
  let ifText: string;
  if (!braces) ifText = `${ind}if (${shape.cond}) ${bodyStmts[0]}`;
  else if (shape.singleLine) ifText = `${ind}if (${shape.cond}) { ${bodyStmts.join(" ")} }`;
  else ifText = `${ind}if (${shape.cond}) {\n${bodyStmts.map((s) => `${ind}  ${s}`).join("\n")}\n${ind}}`;

  const lines = [...prefixStmts.map((s) => ind + s), ifText];
  if (trailingStmt) lines.push(ind + trailingStmt);
  const inner = lines.join("\n");

  const params = "a: boolean, b: boolean, c: boolean";
  const asyncKw = shape.async ? "async " : "";
  let fn: string;
  if (shape.fnKind === "function") fn = `${asyncKw}function f(${params}): ${returnType} {\n${inner}\n}`;
  else if (shape.fnKind === "arrow") fn = `const f = ${asyncKw}(${params}): ${returnType} => {\n${inner}\n};`;
  else fn = `class K {\n  ${asyncKw}m(${params}): ${returnType} {\n${inner}\n  }\n}`;

  const source = `declare function g(n: number): void;\n${fn}\n`;

  let expectedReturnExpr: string | null;
  if (shape.trailing.kind === "returnValue") expectedReturnExpr = "7";
  else if (shape.trailing.kind === "returnBare" || isVoid) expectedReturnExpr = null;
  else expectedReturnExpr = "undefined";

  return { source, shape, bodyStmts, prefixStmts, trailingStmt, expectedReturnExpr };
}

// ---------- verification helpers ----------

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function evalCond(expr: string, env: Record<string, boolean>): boolean {
  // Conditions only use a, b, c, true, false, !, &&, ||, and parentheses.
  return Boolean(new Function(...VARS, `return (${expr});`)(...VARS.map((v) => env[v])));
}

function assignments(): Record<string, boolean>[] {
  const out: Record<string, boolean>[] = [];
  for (let m = 0; m < 1 << VARS.length; m++) {
    out.push(Object.fromEntries(VARS.map((v, i) => [v, (m & (1 << i)) !== 0])));
  }
  return out;
}

const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });

function functionBody(source: string): Block {
  const sf = project.createSourceFile("out.ts", source, { overwrite: true });
  const fn =
    sf.getFirstDescendantByKind(SyntaxKind.MethodDeclaration) ??
    sf.getFirstDescendantByKind(SyntaxKind.ArrowFunction) ??
    sf.getFunctions().find((f) => f.getName() === "f");
  const body = fn?.getBody();
  if (!body || !Node.isBlock(body)) throw new Error("function body not found");
  return body;
}

function parseDiagnostics(source: string): string[] {
  const sf = project.createSourceFile("parse.ts", source, { overwrite: true });
  const diags = (sf.compilerNode as unknown as { parseDiagnostics?: { messageText: unknown }[] }).parseDiagnostics ?? [];
  return diags.map((d) => String(typeof d.messageText === "string" ? d.messageText : JSON.stringify(d.messageText)));
}

describe("Property 13: Guard_Clause transform shape correctness", () => {
  /** **Validates: Requirements 6.2, 6.3, 6.4** */
  it("produces a negated early return followed by the unwrapped original body", () => {
    fc.assert(
      fc.property(arbShape.map(build), (g) => {
        const position = { sourceText: g.source, filePath: "target.ts" };
        const candidates = generateGuardClauseCandidates(position);
        // Exactly the generated top-level `if` is eligible; nested ifs are not function-body statements.
        expect(candidates).toHaveLength(1);

        const result = candidates[0]!.apply(position);
        expect(result.ok, result.error ?? "").toBe(true);
        const out = result.resultingSource!;

        // Output parses.
        expect(parseDiagnostics(out)).toEqual([]);

        const stmts: Statement[] = functionBody(out).getStatements();
        const p = g.prefixStmts.length;

        // Statements before the `if` are untouched.
        expect(stmts.slice(0, p).map((s) => norm(s.getText()))).toEqual(g.prefixStmts);

        // The replaced `if`: no else, body is a single early return.
        const guard = stmts[p];
        if (!guard || !Node.isIfStatement(guard)) throw new Error(`expected if statement in:\n${out}`);
        expect(guard.getElseStatement()).toBeUndefined();
        const early = guard.getThenStatement();
        if (!Node.isReturnStatement(early)) throw new Error(`expected single early return in:\n${out}`);
        const expr = early.getExpression();
        if (g.expectedReturnExpr === null) expect(expr).toBeUndefined();
        else expect(expr?.getText()).toBe(g.expectedReturnExpr);

        // The new condition is the logical negation of the original.
        const newCond = guard.getExpression().getText();
        for (const env of assignments()) {
          expect(evalCond(newCond, env), `${newCond} vs ${g.shape.cond} at ${JSON.stringify(env)}`).toBe(
            !evalCond(g.shape.cond, env),
          );
        }

        // Then the original body statements at the function-body level,
        // then the trailing return unless the body already terminates.
        const expectedRest = [...g.bodyStmts];
        const terminated = g.shape.ending !== "none";
        if (g.trailingStmt && !terminated) expectedRest.push(g.trailingStmt);
        expect(stmts.slice(p + 1).map((s) => norm(s.getText()))).toEqual(expectedRest.map(norm));
      }),
      { numRuns: 100 },
    );
  }, 300_000); // each run loads a fresh ts-morph Project; slow under full-suite parallel load
});
