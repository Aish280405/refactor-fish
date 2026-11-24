// Feature: refactor-fish, Property 8: Referenced-symbol preservation under Remove_Unused
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Project } from "ts-morph";
import { generateRemoveUnused } from "./remove-unused.js";
import type { Position } from "../types.js";

/**
 * For any Position and any Remove_Unused Move applicable to it, every symbol
 * referenced anywhere in the Position before the Move SHALL still be declared
 * in the resulting Position.
 *
 * The generator builds top-level imports (named, aliased, default, namespace,
 * mixed), `const` statements with one or two declarators, and functions, each
 * optionally exported, with a random cross-reference graph. A function may
 * reference itself; that self-reference sits inside its own body and is
 * removed together with it (Requirement 4.3), so it is the only reference not
 * required to survive.
 *
 * **Validates: Requirements 4.4, 24.3**
 */

type Shape =
  | { kind: "import"; hasDefault: boolean; hasNs: boolean; named: boolean[] }
  | { kind: "const"; exported: boolean; count: number }
  | { kind: "function"; exported: boolean };

interface Decl {
  name: string;
  /** Names this declaration references (empty for imports). */
  refs: string[];
}

interface Program {
  source: string;
  decls: Decl[];
}

const shapeArb: fc.Arbitrary<Shape> = fc.oneof(
  fc
    .record({
      kind: fc.constant("import" as const),
      hasDefault: fc.boolean(),
      hasNs: fc.boolean(),
      named: fc.array(fc.boolean(), { maxLength: 3 }),
    })
    .map((s) => {
      // `import * as ns` cannot be combined with named imports.
      const named = s.hasNs ? [] : s.named;
      const hasDefault = s.hasDefault || (!s.hasNs && named.length === 0);
      return { ...s, named, hasDefault };
    }),
  fc.record({
    kind: fc.constant("const" as const),
    exported: fc.boolean(),
    count: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({ kind: fc.constant("function" as const), exported: fc.boolean() }),
);

function declCount(s: Shape): number {
  if (s.kind === "import") return (s.hasDefault ? 1 : 0) + (s.hasNs ? 1 : 0) + s.named.length;
  return s.kind === "const" ? s.count : 1;
}

function render(shapes: Shape[], refIdx: number[][]): Program {
  const total = shapes.reduce((n, s) => n + declCount(s), 0);
  const names = Array.from({ length: total }, (_, i) => `s${i}`);
  const decls: Decl[] = [];
  const lines: string[] = [];
  const list = (refs: string[]) => `[${refs.join(", ")}]`;
  let next = 0;
  let module = 0;
  let refSlot = 0;
  const takeRefs = (own: string, allowSelf: boolean): string[] => {
    const idx = refIdx[refSlot++] ?? [];
    return [...new Set(idx.map((i) => names[i % total]!))].filter((n) => allowSelf || n !== own);
  };

  for (const s of shapes) {
    if (s.kind === "import") {
      const parts: string[] = [];
      if (s.hasDefault) {
        const n = names[next++]!;
        decls.push({ name: n, refs: [] });
        parts.push(n);
      }
      if (s.hasNs) {
        const n = names[next++]!;
        decls.push({ name: n, refs: [] });
        parts.push(`* as ${n}`);
      }
      if (s.named.length > 0) {
        const specs = s.named.map((aliased, k) => {
          const n = names[next++]!;
          decls.push({ name: n, refs: [] });
          return aliased ? `e${k} as ${n}` : n;
        });
        parts.push(`{ ${specs.join(", ")} }`);
      }
      lines.push(`import ${parts.join(", ")} from "m${module++}";`);
    } else if (s.kind === "const") {
      const declarators: string[] = [];
      for (let k = 0; k < s.count; k++) {
        const n = names[next++]!;
        const refs = takeRefs(n, false);
        decls.push({ name: n, refs });
        declarators.push(`${n} = ${list(refs)}`);
      }
      lines.push(`${s.exported ? "export " : ""}const ${declarators.join(", ")};`);
    } else {
      const n = names[next++]!;
      const refs = takeRefs(n, true);
      decls.push({ name: n, refs });
      lines.push(`${s.exported ? "export " : ""}function ${n}() { return ${list(refs)}; }`);
    }
  }
  return { source: lines.join("\n") + "\n", decls };
}

const programArb: fc.Arbitrary<Program> = fc
  .array(shapeArb, { minLength: 1, maxLength: 6 })
  .chain((shapes) => {
    const total = shapes.reduce((n, s) => n + declCount(s), 0);
    const slots = shapes.reduce((n, s) => n + (s.kind === "import" ? 0 : declCount(s)), 0);
    return fc
      .array(fc.array(fc.nat({ max: Math.max(total - 1, 0) }), { maxLength: 3 }), {
        minLength: slots,
        maxLength: slots,
      })
      .map((refIdx) => render(shapes, refIdx));
  });

/** Top-level names declared in `source`: import locals, variables, functions. */
const checkProject = new Project({ useInMemoryFileSystem: true });

function declaredNames(source: string): Set<string> {
  const sf = checkProject.createSourceFile("result.ts", source, { overwrite: true });
  const out = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    const d = imp.getDefaultImport();
    if (d) out.add(d.getText());
    const ns = imp.getNamespaceImport();
    if (ns) out.add(ns.getText());
    for (const spec of imp.getNamedImports()) out.add((spec.getAliasNode() ?? spec.getNameNode()).getText());
  }
  for (const v of sf.getVariableDeclarations()) out.add(v.getName());
  for (const f of sf.getFunctions()) {
    const n = f.getName();
    if (n) out.add(n);
  }
  return out;
}

function targetName(description: string): string {
  const m = /^Remove unused \w+ '(.+)'$/.exec(description);
  if (!m) throw new Error(`unexpected description: ${description}`);
  return m[1]!;
}

describe("Property 8: Referenced-symbol preservation under Remove_Unused", () => {
  it("every symbol referenced before a Remove_Unused Move is still declared after it", () => {
    fc.assert(
      fc.property(programArb, ({ source, decls }) => {
        const position: Position = { sourceText: source, filePath: "target.ts" };
        for (const candidate of generateRemoveUnused(position)) {
          const result = candidate.apply(position);
          if (!result.ok) continue; // Not applicable: Position is unchanged.
          const target = targetName(candidate.describe());
          const required = new Set<string>();
          for (const d of decls) {
            for (const r of d.refs) {
              // Only a self-reference inside the removed declaration may disappear.
              if (!(d.name === target && r === target)) required.add(r);
            }
          }
          const declared = declaredNames(result.resultingSource!);
          const missing = [...required].filter((n) => !declared.has(n));
          expect(missing, `after "${candidate.describe()}" on:\n${source}`).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
