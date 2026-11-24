import { describe, expect, it } from "vitest";
import { generateSimplifyBoolean } from "./simplify-boolean.js";
import type { Position } from "../types.js";

const pos = (sourceText: string): Position => ({ sourceText, filePath: "target.ts" });

function applyAll(src: string): string[] {
  const p = pos(src);
  return generateSimplifyBoolean(p).map((c) => {
    const r = c.apply(p);
    expect(r.ok).toBe(true);
    return r.resultingSource!;
  });
}

describe("Simplify_Boolean", () => {
  it("rewrites x === true for boolean x", () => {
    const src = "export function f(x: boolean) { return x === true; }\n";
    expect(applyAll(src)).toEqual(["export function f(x: boolean) { return x; }\n"]);
  });

  it("skips any, unknown, and unions with non-boolean members", () => {
    const src = [
      "export function a(x: any) { return x === true; }",
      "export function b(x: unknown) { return x === true; }",
      "export function c(x: boolean | undefined) { return x === true; }",
      "",
    ].join("\n");
    expect(generateSimplifyBoolean(pos(src))).toHaveLength(0);
  });

  it("rewrites !!x in if/while/ternary conditions", () => {
    const src = [
      "export function f(x: number) {",
      "  if (!!x) return 1;",
      "  while (!!x) { break; }",
      "  return !!x ? 1 : 2;",
      "}",
      "",
    ].join("\n");
    const outs = applyAll(src);
    expect(outs).toHaveLength(3);
    expect(outs[0]).toContain("if (x) return 1;");
    expect(outs[1]).toContain("while (x)");
    expect(outs[2]).toContain("return x ? 1 : 2;");
  });

  it("does not rewrite !!x used as a value", () => {
    const src = "export function f(x: number) { const y = !!x; return y; }\n";
    expect(generateSimplifyBoolean(pos(src))).toHaveLength(0);
  });

  it("rewrites !!x as &&/|| operand when x is boolean", () => {
    const src = "export function f(x: boolean, y: number) { const z = !!x && y; return z; }\n";
    expect(applyAll(src)).toEqual([
      "export function f(x: boolean, y: number) { const z = x && y; return z; }\n",
    ]);
  });

  it("rewrites if/else return true/false with and without braces", () => {
    const src = [
      "export function a(c: boolean) { if (c) return true; else return false; }",
      "export function b(c: boolean) { if (c) { return true; } else { return false; } }",
      "export function d(c: number) { if (c) return true; else return false; }",
      "",
    ].join("\n");
    const outs = applyAll(src);
    expect(outs).toHaveLength(2);
    expect(outs[0]).toContain("export function a(c: boolean) { return c; }");
    expect(outs[1]).toContain("export function b(c: boolean) { return c; }");
  });

  it("applying one candidate changes only its own site", () => {
    const src = [
      "export function f(a: boolean, b: boolean) {",
      "  return [a === true, b === true];",
      "}",
      "",
    ].join("\n");
    const outs = applyAll(src);
    expect(outs).toHaveLength(2);
    expect(outs[0]).toContain("[a, b === true]");
    expect(outs[1]).toContain("[a === true, b]");
  });

  it("is deterministic and does not mutate the input", () => {
    const src = "export function f(x: boolean) { return x === true; }\n";
    const p = pos(src);
    const c = generateSimplifyBoolean(p)[0]!;
    expect(c.apply(p)).toEqual(c.apply(p));
    expect(p.sourceText).toBe(src);
  });
});
