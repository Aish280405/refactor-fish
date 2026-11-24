// Feature: refactor-fish, Property 9: For any import statement with N named specifiers (N ≥ 1) where one specifier is the Remove_Unused target, applying the Move SHALL remove only that specifier and retain the import statement when N > 1, and SHALL remove the entire import statement when N = 1.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Project } from "ts-morph";
import type { ImportDeclaration } from "ts-morph";
import { generateRemoveUnused } from "./remove-unused.js";
import type { Position } from "../types.js";

/**
 * The generator builds one target import from "m0" whose clause is an optional
 * default binding plus either a namespace binding or 1–3 named specifiers
 * (optionally aliased). Following Requirement 4.6, which speaks of
 * "specifiers" of the statement, default and namespace bindings count toward N
 * alongside named specifiers. One binding is chosen as the target and forced
 * unused; the others are randomly used (exported) or unused. A second,
 * untouched import from "m1" checks that other statements are left alone.
 *
 * **Validates: Requirements 4.6**
 */

type Form = "default" | "namespace" | "named";

interface Binding {
  form: Form;
  local: string;
  imported?: string;
  used: boolean;
}

interface Case {
  source: string;
  bindings: Binding[];
  target: Binding;
  otherImport: string;
}

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    hasDefault: fc.boolean(),
    rest: fc.oneof(
      fc.constant({ kind: "none" as const }),
      fc.constant({ kind: "namespace" as const }),
      fc.record({
        kind: fc.constant("named" as const),
        aliases: fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }),
      }),
    ),
    used: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
    targetPick: fc.nat(),
    otherUsed: fc.boolean(),
  })
  .map(({ hasDefault, rest, used, targetPick, otherUsed }) => {
    const bindings: Binding[] = [];
    if (hasDefault || rest.kind === "none") bindings.push({ form: "default", local: "d0", used: false });
    if (rest.kind === "namespace") bindings.push({ form: "namespace", local: "ns0", used: false });
    if (rest.kind === "named") {
      rest.aliases.forEach((aliased, k) =>
        bindings.push({ form: "named", local: `i${k}`, imported: aliased ? `o${k}` : undefined, used: false }),
      );
    }
    bindings.forEach((b, k) => (b.used = used[k]!));
    const target = bindings[targetPick % bindings.length]!;
    target.used = false;

    const parts: string[] = [];
    const named: string[] = [];
    for (const b of bindings) {
      if (b.form === "default") parts.push(b.local);
      else if (b.form === "namespace") parts.push(`* as ${b.local}`);
      else named.push(b.imported ? `${b.imported} as ${b.local}` : b.local);
    }
    if (named.length > 0) parts.push(`{ ${named.join(", ")} }`);

    const otherImport = `import { keep } from "m1";`;
    const exported = bindings.filter((b) => b.used).map((b) => b.local);
    if (otherUsed) exported.push("keep");
    const source = [
      `import ${parts.join(", ")} from "m0";`,
      otherImport,
      `export const __use = [${exported.join(", ")}];`,
      ``,
    ].join("\n");
    return { source, bindings, target, otherImport };
  });

const checkProject = new Project({ useInMemoryFileSystem: true });

/** Bindings of an import declaration as `form:local` strings, in source order. */
function bindingsOf(imp: ImportDeclaration): string[] {
  const out: string[] = [];
  const d = imp.getDefaultImport();
  if (d) out.push(`default:${d.getText()}`);
  const ns = imp.getNamespaceImport();
  if (ns) out.push(`namespace:${ns.getText()}`);
  for (const spec of imp.getNamedImports()) {
    out.push(`named:${(spec.getAliasNode() ?? spec.getNameNode()).getText()}`);
  }
  return out;
}

describe("Property 9: Import specifier removal granularity", () => {
  it("removes only the target specifier when N > 1 and the whole import when N = 1", () => {
    fc.assert(
      fc.property(caseArb, ({ source, bindings, target, otherImport }) => {
        const position: Position = { sourceText: source, filePath: "target.ts" };
        const description = `Remove unused import '${target.local}'`;
        const candidate = generateRemoveUnused(position).find((c) => c.describe() === description);
        expect(candidate, `no candidate "${description}" for:\n${source}`).toBeDefined();

        const result = candidate!.apply(position);
        expect(result.ok, result.error?.reason).toBe(true);
        const out = result.resultingSource!;

        const sf = checkProject.createSourceFile("result.ts", out, { overwrite: true });
        const fromM0 = sf.getImportDeclarations().filter((i) => i.getModuleSpecifierValue() === "m0");
        const fromM1 = sf.getImportDeclarations().filter((i) => i.getModuleSpecifierValue() === "m1");

        // The other import statement is untouched in every case.
        expect(fromM1.map((i) => i.getText())).toEqual([otherImport]);

        if (bindings.length === 1) {
          expect(fromM0, `import statement should be removed:\n${out}`).toHaveLength(0);
        } else {
          expect(fromM0, `import statement should be kept:\n${out}`).toHaveLength(1);
          const expected = bindings.filter((b) => b !== target).map((b) => `${b.form}:${b.local}`);
          expect(bindingsOf(fromM0[0]!)).toEqual(expected);
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
