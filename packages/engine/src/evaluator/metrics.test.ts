import { describe, expect, it } from "vitest";
import { computeMetrics } from "./metrics.js";

const pos = (sourceText: string) => ({ sourceText, filePath: "target.ts" });

describe("computeMetrics", () => {
  it("gives a trivial function complexity 1, depth 0, length 1", () => {
    const r = computeMetrics(pos("export function f() { return 1; }\n"));
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0]).toMatchObject({
      name: "f",
      cyclomaticComplexity: 1,
      maxNestingDepth: 0,
      functionLength: 1,
    });
    expect(r.metrics).toEqual({
      cyclomaticComplexity: 1,
      maxNestingDepth: 0,
      functionLength: 1,
      duplicatedCode: 0,
      unusedCode: 0,
    });
  });

  it("counts every decision construct in cyclomatic complexity", () => {
    const src = [
      "export function f(a: any, b: any) {",
      "  if (a) {}",
      "  for (let i = 0; i < 1; i++) {}",
      "  for (const k in a) {}",
      "  for (const v of b) {}",
      "  while (a) {}",
      "  do {} while (b);",
      "  switch (a) { case 1: break; case 2: break; default: break; }",
      "  try {} catch {}",
      "  const x = a ? 1 : 2;",
      "  const y = (a && b || a) ?? b;",
      "  a &&= b;",
      "  return x + y;",
      "}",
    ].join("\n");
    // if, 4 loops + do, 2 cases, catch, ternary, &&, ||, ?? = 13 (&&= excluded)
    expect(computeMetrics(pos(src)).functions[0]!.cyclomaticComplexity).toBe(14);
  });

  it("computes max nesting depth from enclosing control structures", () => {
    const src = [
      "export function f(a: number[]) {",
      "  for (const x of a) {",
      "    if (x) {",
      "      try { console.log(x); } finally {}",
      "    }",
      "  }",
      "  switch (a.length) { case 0: return 0; }",
      "  return 1;",
      "}",
    ].join("\n");
    const fm = computeMetrics(pos(src)).functions[0]!;
    expect(fm.maxNestingDepth).toBe(3);
    expect(fm.functionLength).toBe(9);
  });

  it("measures nested functions separately and excludes them from the outer function", () => {
    const src = [
      "export class C {",
      "  m(a: boolean) {",
      "    const g = () => {",
      "      if (a) { if (a) { return 1; } }",
      "      return 2;",
      "    };",
      "    return g();",
      "  }",
      "}",
    ].join("\n");
    const r = computeMetrics(pos(src));
    const [m, g] = r.functions;
    expect(m).toMatchObject({ name: "m", cyclomaticComplexity: 1, maxNestingDepth: 0, functionLength: 7 });
    expect(g).toMatchObject({ name: "g", cyclomaticComplexity: 3, maxNestingDepth: 2, functionLength: 4 });
    expect(r.metrics.cyclomaticComplexity).toBe(4);
    expect(r.metrics.maxNestingDepth).toBe(2);
    expect(r.metrics.functionLength).toBe(11);
  });

  it("counts statements in every repeated block after the first", () => {
    const block = "a.push(1);\n  a.push(2);\n  a.push(3);";
    const src = [
      "export function f(a: number[]) {",
      `  ${block}`,
      "  console.log(a);",
      `  ${block.replace(/\n {2}/g, "\n      ")}`,
      "}",
      "export function g(a: number[]) {",
      `  ${block}`,
      "}",
    ].join("\n");
    expect(computeMetrics(pos(src)).metrics.duplicatedCode).toBe(6);
  });

  it("does not count blocks shorter than 3 statements or overlapping windows", () => {
    const src = [
      "export function f(a: number[]) {",
      "  a.pop(); a.pop();",
      "  a.shift();",
      "  a.pop(); a.pop();",
      "}",
    ].join("\n");
    expect(computeMetrics(pos(src)).metrics.duplicatedCode).toBe(0);
    const overlap = "export function f(a: number[]) { a.pop(); a.pop(); a.pop(); a.pop(); }";
    expect(computeMetrics(pos(overlap)).metrics.duplicatedCode).toBe(0);
  });

  it("counts unused imports, variables, and functions", () => {
    const src = [
      'import { a, b } from "./x";',
      "const unused = 1;",
      "function dead() { return 2; }",
      "export const used = b;",
    ].join("\n");
    expect(computeMetrics(pos(src)).metrics.unusedCode).toBe(3);
  });
});
