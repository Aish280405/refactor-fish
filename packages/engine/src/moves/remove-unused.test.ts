import { describe, expect, it } from "vitest";
import { generateRemoveUnused } from "./remove-unused.js";

const pos = (sourceText: string) => ({ sourceText, filePath: "target.ts" });

describe("Remove_Unused", () => {
  const src = [
    `import { a, b } from "x";`,
    `import c from "y";`,
    `import { d } from "z";`,
    `const unusedVar = 1;`,
    `const usedVar = a;`,
    `function unusedFn() { return unusedFn(); }`,
    `function usedFn() { return usedVar + d; }`,
    `export const exported = 2;`,
    `export function main() { return usedFn(); }`,
    ``,
  ].join("\n");

  it("generates one candidate per unused declaration in source order", () => {
    const names = generateRemoveUnused(pos(src)).map((c) => c.describe());
    expect(names).toEqual([
      "Remove unused import 'b'",
      "Remove unused import 'c'",
      "Remove unused variable 'unusedVar'",
      "Remove unused function 'unusedFn'",
    ]);
  });

  it("removes a single specifier when the import has several, else the whole import", () => {
    const [b, c] = generateRemoveUnused(pos(src));
    expect(b.apply(pos(src)).resultingSource).toContain(`import { a } from "x";`);
    const out = c.apply(pos(src)).resultingSource!;
    expect(out).not.toContain(`from "y"`);
    expect(out).toContain(`import { a, b } from "x";`);
  });

  it("removes only the targeted variable/function and leaves input unchanged", () => {
    const cands = generateRemoveUnused(pos(src));
    const v = cands[2].apply(pos(src)).resultingSource!;
    expect(v).not.toContain("unusedVar");
    expect(v).toContain("function unusedFn");
    const f = cands[3].apply(pos(src)).resultingSource!;
    expect(f).not.toContain("unusedFn");
    expect(f).toContain("const unusedVar");
  });

  it("rejects when the target no longer exists", () => {
    const [b] = generateRemoveUnused(pos(src));
    const r = b.apply(pos(`const z = 1;\nexport {z};\n`));
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBeTruthy();
  });
});
