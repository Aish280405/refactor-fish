import { AstEditor, safeApply } from "../ast-editor.js";
import type { ApplyResult, Candidate, Position } from "../types.js";
import { findUnusedDeclarations } from "./unused-classifier.js";
import type { UnusedDeclaration } from "./unused-classifier.js";

function describeTarget(d: { kind: string; name: string }): string {
  return `Remove unused ${d.kind} '${d.name}'`;
}

/** Re-locates the target in `position`: same kind+name at the same start, else first same kind+name. */
function relocate(
  declarations: UnusedDeclaration[],
  target: { kind: string; name: string; start: number },
): UnusedDeclaration | undefined {
  const same = declarations.filter((d) => d.kind === target.kind && d.name === target.name);
  return same.find((d) => d.start === target.start) ?? same[0];
}

function removeDeclaration(d: UnusedDeclaration): void {
  if (d.kind === "variable" || d.kind === "function") {
    d.declaration.remove();
    return;
  }
  const imp = d.importDeclaration;
  const total =
    imp.getNamedImports().length +
    (imp.getDefaultImport() ? 1 : 0) +
    (imp.getNamespaceImport() ? 1 : 0);
  if (total <= 1) {
    imp.remove();
  } else if (d.form === "named") {
    d.specifier!.remove();
  } else if (d.form === "default") {
    imp.removeDefaultImport();
  } else {
    imp.removeNamespaceImport();
  }
}

function makeCandidate(d: UnusedDeclaration): Candidate {
  const target = { kind: d.kind, name: d.name, start: d.start };
  return {
    move: "RemoveUnused",
    displayName: "Remove unused",
    describe: () => describeTarget(target),
    apply(position: Position): ApplyResult {
      return safeApply(position, (unit) => {
        const found = relocate(findUnusedDeclarations(unit.getSourceFile()), target);
        if (!found) throw new Error(`${describeTarget(target)}: target not found or no longer unused`);
        removeDeclaration(found);
      });
    },
  };
}

/** One candidate per unused import, variable, or function, in source order. */
export function generateRemoveUnused(position: Position): Candidate[] {
  try {
    const sf = AstEditor.load(position).getSourceFile();
    return findUnusedDeclarations(sf).map(makeCandidate);
  } catch {
    return [];
  }
}

export const RemoveUnusedGenerator = { generate: generateRemoveUnused };
