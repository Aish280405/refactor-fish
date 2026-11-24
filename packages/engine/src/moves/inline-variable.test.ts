import { describe, expect, it } from "vitest";
import { parsesCleanly } from "../ast-editor.js";
import type { Position } from "../types.js";
import { generateInlineVariable } from "./inline-variable.js";

const pos = (sourceText: string): Position => ({ sourceText, filePath: "target.ts" });

function inlineAll(src: string): string[] {
  const p = pos(src);
  return generateInlineVariable(p).map((c) => {
    const r = c.apply(p);
    expect(r.ok).toBe(true);
    expect(parsesCleanly(r.resultingSource!)).toBe(true);
    return r.resultingSource!;
  });
}

describe("Inline_Variable eligibility", () => {
  it("generates a candidate for a single-use const", () => {
    const out = inlineAll("export function f(a: number) {\n  const x = a * 2;\n  return x;\n}\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("return a * 2;");
    expect(out[0]).not.toContain("const x");
  });

  it("skips zero or multiple references, exported, let, destructuring, and no initializer", () => {
    const srcs = [
      "export function f() {\n  const x = 1;\n  return 2;\n}\n",
      "export function f() {\n  const x = 1;\n  return x + x;\n}\n",
      "export const x = 1;\nexport function f() { return x; }\n",
      "const x = 1;\nexport { x };\n",
      "const x = 1;\nexport default x;\n",
      "export function f() {\n  let x = 1;\n  return x;\n}\n",
      "export function f(o: { a: number }) {\n  const { a } = o;\n  return a;\n}\n",
    ];
    for (const s of srcs) expect(generateInlineVariable(pos(s))).toHaveLength(0);
  });

  it("rejects a side-effecting expression between declaration and reference", () => {
    const src = "declare function log(): void;\nexport function f(a: number) {\n  const x = a + 1;\n  log();\n  return x;\n}\n";
    expect(generateInlineVariable(pos(src))).toHaveLength(0);
  });

  it("rejects reassignment of a variable the initializer reads", () => {
    const src = "export function f(a: number) {\n  let y = a;\n  const x = y;\n  y = 5;\n  return x;\n}\n";
    expect(generateInlineVariable(pos(src))).toHaveLength(0);
  });

  it("rejects a side-effecting initializer when the reference is nested", () => {
    const g = "declare function g(): number;\n";
    const fn = `${g}export function f() {\n  const x = g();\n  return () => x;\n}\n`;
    const loop = `${g}export function f(n: number) {\n  const x = g();\n  for (let i = 0; i < n; i++) { n + x; }\n}\n`;
    const cond = `${g}export function f(c: boolean) {\n  const x = g();\n  return c ? x : 0;\n}\n`;
    for (const s of [fn, loop, cond]) expect(generateInlineVariable(pos(s))).toHaveLength(0);
  });

  it("allows a side-effecting initializer when the reference is not nested", () => {
    const src = "declare function g(): number;\nexport function f() {\n  const x = g();\n  return x;\n}\n";
    expect(inlineAll(src)[0]).toContain("return g();");
  });

  it("allows a pure initializer in a nested function", () => {
    const src = "export function f(a: number) {\n  const x = a + 1;\n  return () => x;\n}\n";
    expect(inlineAll(src)[0]).toContain("() => a + 1");
  });
});

describe("Inline_Variable apply", () => {
  it("adds parentheses where precedence requires", () => {
    const src = "export function f(a: number, b: number) {\n  const s = a + b;\n  return s * 2;\n}\n";
    expect(inlineAll(src)[0]).toContain("return (a + b) * 2;");
  });

  it("omits parentheses when not required", () => {
    const src = "export function f(a: number, b: number) {\n  const s = a * b;\n  return s + 2;\n}\n";
    expect(inlineAll(src)[0]).toContain("return a * b + 2;");
  });

  it("parenthesizes a conditional used as an operand and a lower-precedence init in a member access", () => {
    const src = "export function f(c: boolean) {\n  const v = c ? 1 : 2;\n  return v.toFixed();\n}\n";
    expect(inlineAll(src)[0]).toContain("(c ? 1 : 2).toFixed()");
  });

  it("expands a shorthand property", () => {
    const src = "export function f(a: number) {\n  const x = a + 1;\n  return { x };\n}\n";
    expect(inlineAll(src)[0]).toContain("return { x: a + 1 };");
  });

  it("deletes only the inlined declarator", () => {
    const src = "export function f(a: number) {\n  const x = a + 1, y = 2;\n  return x + y;\n}\n";
    const p = pos(src);
    const cands = generateInlineVariable(p);
    expect(cands.map((c) => c.describe())).toEqual(["Inline variable 'x'", "Inline variable 'y'"]);
    expect(cands[0]!.apply(p).resultingSource).toContain("const y = 2;");
    expect(cands[0]!.apply(p).resultingSource).toContain("return a + 1 + y;");
  });

  it("is deterministic and does not mutate the Position", () => {
    const src = "export function f(a: number) {\n  const x = a + 1;\n  return x;\n}\n";
    const p = pos(src);
    const c = generateInlineVariable(p)[0]!;
    expect(c.apply(p).resultingSource).toBe(c.apply(p).resultingSource);
    expect(p.sourceText).toBe(src);
  });

  it("reports failure when the candidate no longer applies", () => {
    const p = pos("export function f(a: number) {\n  const x = a + 1;\n  return x;\n}\n");
    const c = generateInlineVariable(p)[0]!;
    const r = c.apply(pos("export function f() { return 1; }\n"));
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBeTruthy();
  });
});
