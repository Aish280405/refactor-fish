// Feature: refactor-fish, Property 7: For any Position and any one of its Remove_Unused candidates, applying that candidate SHALL produce a resulting Position that differs from the original only in the text of the targeted declaration (or specifier), leaves every other declaration's text unchanged, and parses with zero syntax errors.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { AstEditor, parsesCleanly } from "../ast-editor.js";
import { generateRemoveUnused } from "./remove-unused.js";
import { findUnusedDeclarations } from "./unused-classifier.js";
import type { Position } from "../types.js";

// ---------------------------------------------------------------------------
// Generator: structured shapes rendered to source with globally unique names.
// Used/unused is controlled per binding; "used" means listed in a final export.
// Variables and functions may also reference earlier names, which makes those
// names used through a non-exported reference.
// ---------------------------------------------------------------------------

const arbImport = fc.record({
  def: fc.option(fc.boolean(), { nil: undefined }),
  ns: fc.option(fc.boolean(), { nil: undefined }),
  named: fc.array(fc.record({ used: fc.boolean(), alias: fc.boolean() }), { maxLength: 3 }),
});

const arbVarStatement = fc.record({
  keyword: fc.constantFrom("const", "let"),
  decls: fc.array(
    fc.record({
      used: fc.boolean(),
      ref: fc.option(fc.nat(), { nil: undefined }),
      value: fc.integer({ min: 0, max: 99 }),
    }),
    { minLength: 1, maxLength: 2 },
  ),
});

const arbFunction = fc.record({
  used: fc.boolean(),
  selfCall: fc.boolean(),
  local: fc.boolean(),
  ref: fc.option(fc.nat(), { nil: undefined }),
  value: fc.integer({ min: 0, max: 99 }),
});

const arbShape = fc.record({
  imports: fc.array(arbImport, { maxLength: 3 }),
  vars: fc.array(arbVarStatement, { maxLength: 3 }),
  funcs: fc.array(arbFunction, { maxLength: 3 }),
});

type Shape = typeof arbShape extends fc.Arbitrary<infer T> ? T : never;

function render(shape: Shape): string {
  const lines: string[] = [];
  const exported: string[] = [];
  const pool: string[] = [];
  let n = 0;
  const fresh = (prefix: string) => `${prefix}${n++}`;
  const pick = (ref: number | undefined) =>
    ref === undefined || pool.length === 0 ? undefined : pool[ref % pool.length];

  shape.imports.forEach((imp, k) => {
    let def = imp.def;
    const ns = imp.named.length > 0 ? undefined : imp.ns; // `* as` cannot combine with `{}`
    if (def === undefined && ns === undefined && imp.named.length === 0) def = false;
    const clause: string[] = [];
    const bind = (name: string, used: boolean) => {
      pool.push(name);
      if (used) exported.push(name);
    };
    if (def !== undefined) {
      const name = fresh("d");
      clause.push(name);
      bind(name, def);
    }
    if (ns !== undefined) {
      const name = fresh("ns");
      clause.push(`* as ${name}`);
      bind(name, ns);
    }
    if (imp.named.length > 0) {
      const specs = imp.named.map((s) => {
        const name = fresh("i");
        bind(name, s.used);
        return s.alias ? `o${name} as ${name}` : name;
      });
      clause.push(`{ ${specs.join(", ")} }`);
    }
    lines.push(`import ${clause.join(", ")} from "m${k}";`);
  });

  for (const stmt of shape.vars) {
    const decls = stmt.decls.map((d) => {
      const name = fresh("v");
      const init = pick(d.ref) ?? String(d.value);
      pool.push(name);
      if (d.used) exported.push(name);
      return `${name} = ${init}`;
    });
    lines.push(`${stmt.keyword} ${decls.join(", ")};`);
  }

  for (const f of shape.funcs) {
    const name = fresh("f");
    const ref = pick(f.ref);
    const body: string[] = [];
    if (f.local) body.push(`  const ${fresh("l")} = ${f.value};`);
    body.push(`  return ${ref ?? f.value}${f.selfCall ? ` + ${name}()` : ""};`);
    lines.push(`function ${name}(): number {`, ...body, `}`);
    pool.push(name);
    if (f.used) exported.push(name);
  }

  lines.push(`export const __use = [${exported.join(", ")}];`, ``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------

const load = (sourceText: string): SourceFile =>
  AstEditor.load({ sourceText, filePath: "target.ts" }).getSourceFile();

interface Tok {
  text: string;
  start: number;
  end: number;
}

/** Leaf tokens of the syntax tree in source order (trivia excluded). */
function tokens(sf: SourceFile): Tok[] {
  return sf
    .getDescendants()
    .filter(
      (d) =>
        d.getChildCount() === 0 &&
        d.getKind() !== SyntaxKind.EndOfFileToken &&
        d.getWidth() > 0,
    )
    .map((d) => ({ text: d.getText(), start: d.getStart(), end: d.getEnd() }))
    .sort((a, b) => a.start - b.start);
}

function tokenRange(toks: Tok[], node: Node): [number, number] {
  const lo = node.getStart();
  const hi = node.getEnd();
  const idx = toks.map((t, i) => (t.start >= lo && t.end <= hi ? i : -1)).filter((i) => i >= 0);
  return [idx[0], idx[idx.length - 1] + 1];
}

/** Named declarations (import bindings, variable declarators, functions) by local name. */
function inventory(sf: SourceFile): Map<string, { text: string; start: number; end: number }> {
  const out = new Map<string, { text: string; start: number; end: number }>();
  const add = (name: string, node: Node) =>
    out.set(name, { text: node.getText(), start: node.getStart(), end: node.getEnd() });
  for (const imp of sf.getImportDeclarations()) {
    const def = imp.getDefaultImport();
    if (def) add(def.getText(), def);
    const ns = imp.getNamespaceImport();
    if (ns) add(ns.getText(), ns.getParentOrThrow());
    for (const spec of imp.getNamedImports()) {
      add((spec.getAliasNode() ?? spec.getNameNode()).getText(), spec);
    }
  }
  sf.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node) && Node.isIdentifier(node.getNameNode())) {
      add(node.getName(), node);
    } else if (Node.isFunctionDeclaration(node) && node.getName()) {
      add(node.getName()!, node);
    }
  });
  return out;
}

/** The targeted node and its enclosing statement in the original source. */
function locateTarget(sf: SourceFile, kind: string, name: string): { node: Node; stmt: Node } {
  const d = findUnusedDeclarations(sf).find((u) => u.kind === kind && u.name === name);
  if (!d) throw new Error(`target ${kind} '${name}' not found in original`);
  if (d.kind === "import") {
    const node =
      d.form === "named"
        ? d.specifier!
        : d.form === "default"
          ? d.importDeclaration.getDefaultImportOrThrow()
          : d.importDeclaration.getNamespaceImportOrThrow().getParentOrThrow();
    return { node, stmt: d.importDeclaration };
  }
  if (d.kind === "variable") return { node: d.declaration, stmt: d.declaration.getVariableStatementOrThrow() };
  return { node: d.declaration, stmt: d.declaration };
}

/** True when the statement declares exactly one binding (so removing it removes the statement). */
function soleBinding(stmt: Node): boolean {
  if (Node.isImportDeclaration(stmt)) {
    return (
      stmt.getNamedImports().length +
        (stmt.getDefaultImport() ? 1 : 0) +
        (stmt.getNamespaceImport() ? 1 : 0) ===
      1
    );
  }
  if (Node.isVariableStatement(stmt)) return stmt.getDeclarations().length === 1;
  return true;
}

/**
 * If `after` equals `before` with exactly one contiguous slice removed, returns
 * every equivalent [start, end) slice (they differ only by shifting across equal
 * tokens). Otherwise returns an empty list.
 */
function removedSlices(before: string[], after: string[]): Array<[number, number]> {
  const k = before.length - after.length;
  if (k <= 0) return [];
  let p = 0;
  while (p < after.length && before[p] === after[p]) p++;
  for (let i = p; i < after.length; i++) if (after[i] !== before[i + k]) return [];
  const slices: Array<[number, number]> = [[p, p + k]];
  for (let a = p; a > 0 && before[a - 1] === before[a - 1 + k]; a--) slices.push([a - 1, a - 1 + k]);
  return slices;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 7: Remove_Unused application locality and validity", () => {
  /** **Validates: Requirements 4.2** */
  it("removes only the targeted declaration, keeps all others verbatim, and parses cleanly", () => {
    let applied = 0;
    fc.assert(
      fc.property(arbShape, fc.nat(), (shape, pickIndex) => {
        const sourceText = render(shape);
        const position: Position = { sourceText, filePath: "target.ts" };
        const candidates = generateRemoveUnused(position);
        if (candidates.length === 0) return;
        const candidate = candidates[pickIndex % candidates.length];
        const match = /^Remove unused (import|variable|function) '(.+)'$/.exec(candidate.describe());
        expect(match, candidate.describe()).not.toBeNull();
        const [, kind, name] = match!;

        const result = candidate.apply(position);
        expect(result.ok, result.error?.reason).toBe(true);
        const out = result.resultingSource!;
        applied++;

        // Validity: zero syntax errors; original Position untouched.
        expect(parsesCleanly(out)).toBe(true);
        expect(position.sourceText).toBe(sourceText);

        const origSf = load(sourceText);
        const outSf = load(out);
        const { node: target, stmt } = locateTarget(origSf, kind, name);

        // Every other declaration still exists with identical text; only the target is gone.
        const before = inventory(origSf);
        const after = inventory(outSf);
        expect(after.has(name)).toBe(false);
        for (const [other, decl] of before) {
          if (other === name) continue;
          // Declarations nested inside the target are part of its text and go with it.
          if (decl.start >= target.getStart() && decl.end <= target.getEnd()) continue;
          expect(after.has(other), `declaration '${other}' was removed`).toBe(true);
          const containsTarget = decl.start <= target.getStart() && decl.end >= target.getEnd();
          if (!containsTarget) expect(after.get(other)!.text).toBe(decl.text);
        }
        for (const other of after.keys()) expect(before.has(other)).toBe(true);
        expect(after.size).toBeLessThan(before.size);

        // Locality: the token stream differs by exactly one contiguous slice that is
        // the target (plus one adjacent comma), or its whole statement when it was the
        // statement's only binding/declarator.
        const origToks = tokens(origSf);
        const slices = removedSlices(
          origToks.map((t) => t.text),
          tokens(outSf).map((t) => t.text),
        );
        expect(slices.length, "result is not the original minus one contiguous token slice").toBeGreaterThan(0);
        // A last remaining named specifier takes its `{ }` with it.
        const parent = target.getParent();
        const unit =
          Node.isImportSpecifier(target) && parent && Node.isNamedImports(parent) &&
          parent.getElements().length === 1
            ? parent
            : target;
        const [ts, te] = tokenRange(origToks, unit);
        const [ss, se] = tokenRange(origToks, stmt);
        const allowed: Array<[number, number]> = [[ts, te]];
        if (soleBinding(stmt)) allowed.push([ss, se]);
        if (origToks[te]?.text === ",") allowed.push([ts, te + 1]);
        if (origToks[ts - 1]?.text === ",") allowed.push([ts - 1, te]);
        const ok = slices.some(([a, b]) => allowed.some(([x, y]) => a === x && b === y));
        expect(ok, `removed slice ${JSON.stringify(slices)} not in ${JSON.stringify(allowed)}`).toBe(true);
      }),
      { numRuns: 100 },
    );
    expect(applied).toBeGreaterThan(50);
  }, 600_000);
});
