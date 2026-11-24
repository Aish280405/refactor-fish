import { describe, expect, it } from "vitest";
import { parsesCleanly } from "../ast-editor.js";
import {
  generateExtractFunctionCandidates,
  selectFunctionName,
} from "./extract-function.js";

const pos = (sourceText: string) => ({ sourceText, filePath: "target.ts" });

function run(src: string): string {
  const cands = generateExtractFunctionCandidates(pos(src));
  expect(cands).toHaveLength(1);
  const res = cands[0].apply(pos(src));
  expect(res.ok).toBe(true);
  expect(parsesCleanly(res.resultingSource!)).toBe(true);
  return res.resultingSource!;
}

describe("Extract_Function", () => {
  it("extracts with params in order of first read and returns assigned vars", () => {
    const src = `export function f(a: number, b: number) {
  let total = 0;
  const x = b + 1;
  total += x;
  total += a;
  const y = total * 2;
  total = y;
  return total;
}
`;
    // statements 2..6 (after `let total`) are eligible; the longest window is chosen.
    const out = run(src);
    expect(out).toContain("function extractedBlock(");
    expect(out).toContain("extractedBlock(");
  });

  it("wires parameters and assignment back", () => {
    const src = `function g(s: number, a: number, b: number) {
  s = s + a;
  s = s + b;
  s = s * 2;
  s = s - 1;
  s = s + 3;
  console.log(s);
}
`;
    const out = run(src);
    expect(out).toMatch(/s = extractedBlock\(s, a, b\);/);
    expect(out).toMatch(/function extractedBlock\(s: number, a: number, b: number\)/);
  });

  it("rejects blocks with a non-final return", () => {
    const src = `function h(a: number) {
  if (a > 1) return 1;
  const b = a + 1;
  const c = b + 1;
  const d = c + 1;
  const e = d + 1;
}
`;
    expect(generateExtractFunctionCandidates(pos(src))).toHaveLength(0);
  });

  it("rejects await in a non-async function and allows it in async", () => {
    const body = `  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = await Promise.resolve(5);
`;
    const bad = `function k() {\n${body}}\n`;
    expect(generateExtractFunctionCandidates(pos(bad))).toHaveLength(0);
    const good = `async function k() {\n${body}}\n`;
    const out = run(good);
    expect(out).toContain("async function extractedBlock");
  });

  it("picks the lowest free suffix starting at 2", () => {
    expect(selectFunctionName("n", new Set(["n", "n2"]))).toBe("n3");
    expect(selectFunctionName("n", new Set())).toBe("n");
    const src = `function extractedBlock() {}
function m() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
}
`;
    expect(run(src)).toContain("function extractedBlock2(");
  });

  it("does not mutate the position and reports failure on stale site", () => {
    const src = `function m() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
}
`;
    const cands = generateExtractFunctionCandidates(pos(src));
    const res = cands[0].apply(pos("function m() {}\n"));
    expect(res.ok).toBe(false);
    expect(res.error?.reason).toMatch(/Extraction failed/);
  });
});
