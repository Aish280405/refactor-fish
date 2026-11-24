// Feature: refactor-fish, Property 6: For any Position containing an arbitrary mix of imports, variables, and functions where each declaration is independently marked as referenced-elsewhere, exported, or neither, the Move_Generator SHALL generate exactly one Remove_Unused candidate for each declaration that is neither exported nor referenced outside its own body, and SHALL generate none for any other declaration.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateRemoveUnused } from "./remove-unused.js";

/**
 * Scope note: the classifier intentionally skips destructured variables,
 * for-loop variables, `declare` declarations, and bodiless/overloaded
 * functions, so the generated Positions contain none of those.
 */

type Status = "referenced" | "exported" | "neither";
type Kind = "import" | "variable" | "function";

const arbStatus: fc.Arbitrary<Status> = fc.constantFrom("referenced", "exported", "neither");

interface Decl {
  kind: Kind;
  name: string;
  status: Status;
}

/** One import specifier slot before names are assigned. */
interface ImportShape {
  defaultImport: Status | null;
  namespaceImport: Status | null;
  named: { status: Status; alias: boolean }[];
}

const arbImportShape: fc.Arbitrary<ImportShape> = fc.oneof(
  // default and/or named specifiers
  fc.record({
    defaultImport: fc.option(arbStatus, { nil: null }),
    namespaceImport: fc.constant(null),
    named: fc.array(fc.record({ status: arbStatus, alias: fc.boolean() }), { minLength: 1, maxLength: 3 }),
  }),
  // namespace import, optionally with a default import
  fc.record({
    defaultImport: fc.option(arbStatus, { nil: null }),
    namespaceImport: arbStatus,
    named: fc.constant([]),
  }),
);

interface VarShape {
  status: Status;
  keyword: "const" | "let" | "var";
  exportViaSpecifier: boolean;
  selfReference: boolean;
}

interface FnShape {
  status: Status;
  exportViaSpecifier: boolean;
  selfReference: boolean;
}

const arbVarShape: fc.Arbitrary<VarShape> = fc.record({
  status: arbStatus,
  keyword: fc.constantFrom("const", "let", "var"),
  exportViaSpecifier: fc.boolean(),
  selfReference: fc.boolean(),
});

const arbFnShape: fc.Arbitrary<FnShape> = fc.record({
  status: arbStatus,
  exportViaSpecifier: fc.boolean(),
  selfReference: fc.boolean(),
});

/** Non-import top-level declarations, interleaved in arbitrary order. */
const arbBodyDecl = fc.oneof(
  arbVarShape.map((v) => ({ type: "variable" as const, v })),
  arbFnShape.map((f) => ({ type: "function" as const, f })),
);

interface Generated {
  source: string;
  /** Declarations in source order. */
  decls: Decl[];
}

const arbPosition: fc.Arbitrary<Generated> = fc
  .record({
    imports: fc.array(arbImportShape, { maxLength: 3 }),
    body: fc.array(arbBodyDecl, { maxLength: 6 }),
  })
  .map(({ imports, body }) => {
    const lines: string[] = [];
    const decls: Decl[] = [];
    const referenced: string[] = [];
    const exportSpecifiers: string[] = [];
    let n = 0;

    const track = (kind: Kind, name: string, status: Status, viaSpecifier: boolean) => {
      decls.push({ kind, name, status });
      if (status === "referenced") referenced.push(name);
      if (status === "exported" && viaSpecifier) exportSpecifiers.push(name);
    };

    imports.forEach((imp, i) => {
      const parts: string[] = [];
      if (imp.defaultImport) {
        const name = `def${n++}`;
        parts.push(name);
        track("import", name, imp.defaultImport, true);
      }
      if (imp.namespaceImport) {
        const name = `ns${n++}`;
        parts.push(`* as ${name}`);
        track("import", name, imp.namespaceImport, true);
      }
      if (imp.named.length > 0) {
        const specs = imp.named.map((s) => {
          const local = `imp${n++}`;
          track("import", local, s.status, true);
          return s.alias ? `orig${local} as ${local}` : local;
        });
        parts.push(`{ ${specs.join(", ")} }`);
      }
      lines.push(`import ${parts.join(", ")} from "mod${i}";`);
    });

    for (const item of body) {
      if (item.type === "variable") {
        const { status, keyword, exportViaSpecifier, selfReference } = item.v;
        const name = `v${n++}`;
        const viaSpec = status === "exported" && exportViaSpecifier;
        const prefix = status === "exported" && !viaSpec ? "export " : "";
        // A reference inside the declarator's own initializer is inside its body.
        const init = selfReference ? `() => ${name}` : `${n}`;
        lines.push(`${prefix}${keyword} ${name} = ${init};`);
        track("variable", name, status, viaSpec);
      } else {
        const { status, exportViaSpecifier, selfReference } = item.f;
        const name = `f${n++}`;
        const viaSpec = status === "exported" && exportViaSpecifier;
        const prefix = status === "exported" && !viaSpec ? "export " : "";
        const ret = selfReference ? name : `${n}`;
        lines.push(`${prefix}function ${name}() { return ${ret}; }`);
        track("function", name, status, viaSpec);
      }
    }

    if (exportSpecifiers.length > 0) lines.push(`export { ${exportSpecifiers.join(", ")} };`);
    // The sink is exported, so it is never a candidate itself.
    lines.push(`export function sink() { return [${referenced.join(", ")}]; }`);
    lines.push("");

    // Imports come first in the source, then body declarations, matching `decls` order.
    return { source: lines.join("\n"), decls };
  });

describe("Property 6: Remove_Unused candidate generation matches usage classification", () => {
  /** **Validates: Requirements 4.1, 4.3** */
  it("generates exactly one candidate per declaration that is neither exported nor referenced", () => {
    fc.assert(
      fc.property(arbPosition, ({ source, decls }) => {
        const candidates = generateRemoveUnused({ sourceText: source, filePath: "target.ts" });
        const expected = decls
          .filter((d) => d.status === "neither")
          .map((d) => `Remove unused ${d.kind} '${d.name}'`);

        for (const c of candidates) expect(c.move).toBe("RemoveUnused");
        expect(candidates.map((c) => c.describe())).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  }, 300_000); // each run loads a fresh in-memory ts-morph Project
});
