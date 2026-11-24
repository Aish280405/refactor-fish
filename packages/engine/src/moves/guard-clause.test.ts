import { describe, expect, it } from "vitest";
import { generateGuardClauseCandidates } from "./guard-clause.js";

const pos = (sourceText: string) => ({ sourceText, filePath: "target.ts" });

function applyFirst(src: string): string {
  const cands = generateGuardClauseCandidates(pos(src));
  expect(cands.length).toBe(1);
  const r = cands[0]!.apply(pos(src));
  expect(r.ok).toBe(true);
  return r.resultingSource!;
}

describe("Guard_Clause generator", () => {
  it("void function, if followed by nothing", () => {
    const out = applyFirst(`function f(a: boolean): void {\n  if (a) {\n    g();\n    h();\n  }\n}\n`);
    expect(out).toBe(`function f(a: boolean): void {\n  if (!a) return;\n  g();\n  h();\n}\n`);
  });

  it("uses following return expression", () => {
    const out = applyFirst(
      `function f(a: boolean): number {\n  if (a) {\n    g();\n  }\n  return 1;\n}\n`,
    );
    expect(out).toBe(
      `function f(a: boolean): number {\n  if (!a) return 1;\n  g();\n  return 1;\n}\n`,
    );
  });

  it("emits return undefined when type includes undefined", () => {
    const out = applyFirst(
      `function f(a: boolean): number | undefined {\n  if (a) {\n    return 2;\n  }\n}\n`,
    );
    expect(out).toContain("if (!a) return undefined;");
  });

  it("no candidate for non-void type excluding undefined with nothing following", () => {
    const src = `function f(a: boolean): number {\n  if (a) {\n    return 2;\n  }\n  return 3;\n  }\nfunction g(a: boolean): number {\n  if (a) {\n    throw new Error();\n  }\n}\n`;
    const cands = generateGuardClauseCandidates(pos(src));
    // f qualifies (single return follows); g does not (non-void, nothing follows)
    expect(cands.length).toBe(1);
  });

  it("no candidate with else or other trailing statements", () => {
    expect(
      generateGuardClauseCandidates(pos(`function f(a: boolean) {\n  if (a) { g(); } else { h(); }\n}\n`)),
    ).toHaveLength(0);
    expect(
      generateGuardClauseCandidates(pos(`function f(a: boolean) {\n  if (a) { g(); }\n  h();\n}\n`)),
    ).toHaveLength(0);
  });

  it("no candidate on name collision", () => {
    const src = `function f(a: boolean): void {\n  const x = 1;\n  if (a) {\n    const x = 2;\n    g(x);\n  }\n}\n`;
    expect(generateGuardClauseCandidates(pos(src))).toHaveLength(0);
  });

  it("negates `!x` by stripping and wraps complex conditions", () => {
    expect(applyFirst(`function f(a: boolean): void {\n  if (!a) {\n    g();\n  }\n}\n`)).toContain(
      "if (a) return;",
    );
    expect(
      applyFirst(`function f(a: boolean, b: boolean): void {\n  if (a && b) {\n    g();\n  }\n}\n`),
    ).toContain("if (!(a && b)) return;");
  });

  it("is deterministic and does not mutate input", () => {
    const src = `function f(a: boolean): void {\n  if (a) {\n    g();\n  }\n}\n`;
    const c = generateGuardClauseCandidates(pos(src))[0]!;
    expect(c.apply(pos(src)).resultingSource).toBe(c.apply(pos(src)).resultingSource);
  });
});
