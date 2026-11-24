import { describe, expect, it } from "vitest";
import { AstEditor, parsesCleanly, safeApply } from "./ast-editor.js";
import type { Position } from "./types.js";

const pos: Position = { sourceText: "const a = 1;\n// keep\nconst b = a + 1;\n", filePath: "target.ts" };

describe("AstEditor", () => {
  it("load gives independent units and commit returns text without mutating the Position", () => {
    const u1 = AstEditor.load(pos);
    const u2 = AstEditor.load(pos);
    u1.getSourceFile().getVariableDeclarationOrThrow("a").getInitializerOrThrow().replaceWithText("5");
    expect(u1.commit()).toContain("const a = 5;");
    expect(u2.commit()).toBe(pos.sourceText);
    expect(pos.sourceText).toContain("const a = 1;");
    expect(u2.getTypeChecker()).toBeDefined();
  });

  it("parsesCleanly detects syntax errors", () => {
    expect(parsesCleanly(pos.sourceText)).toBe(true);
    expect(parsesCleanly("const = ;")).toBe(false);
  });
});

describe("safeApply", () => {
  it("returns resulting source and preserves comments", () => {
    const r = safeApply(pos, (u) =>
      u.getSourceFile().getVariableDeclarationOrThrow("a").getInitializerOrThrow().replaceWithText("2"),
    );
    expect(r.ok).toBe(true);
    expect(r.resultingSource).toContain("// keep");
    expect(pos.sourceText).toContain("const a = 1;");
  });

  it("reports failure when the edit throws", () => {
    const r = safeApply(pos, (u) => {
      u.getSourceFile().getVariableDeclarationOrThrow("missing");
    });
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toBeTruthy();
    expect(r.resultingSource).toBeUndefined();
  });

  it("reports failure when the output is unparseable", () => {
    const r = safeApply(pos, (u) => {
      u.getSourceFile().replaceWithText("function (");
    });
    expect(r.ok).toBe(false);
    expect(r.error?.reason).toMatch(/unparseable/);
  });
});
