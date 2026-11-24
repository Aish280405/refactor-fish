import { Node } from "ts-morph";
import type {
  FunctionDeclaration,
  ImportSpecifier,
  Identifier,
  ImportDeclaration,
  SourceFile,
  VariableDeclaration,
} from "ts-morph";

export type UnusedKind = "import" | "variable" | "function";

interface UnusedBase {
  kind: UnusedKind;
  name: string;
  /** Start offset of the declaration (specifier, declarator, or function). */
  start: number;
}

export interface UnusedImport extends UnusedBase {
  kind: "import";
  /** Specifier node (named), or the import declaration for default/namespace. */
  importDeclaration: ImportDeclaration;
  form: "named" | "default" | "namespace";
  specifier?: ImportSpecifier;
}

export interface UnusedVariable extends UnusedBase {
  kind: "variable";
  declaration: VariableDeclaration;
}

export interface UnusedFunction extends UnusedBase {
  kind: "function";
  declaration: FunctionDeclaration;
}

export type UnusedDeclaration = UnusedImport | UnusedVariable | UnusedFunction;

/** True when `name` has a reference outside `body` (the declaration's own text range). */
function hasOutsideReference(name: Identifier, body: Node): boolean {
  const lo = body.getStart();
  const hi = body.getEnd();
  return name.findReferencesAsNodes().some((ref) => {
    if (ref.getSourceFile() !== name.getSourceFile()) return true;
    const pos = ref.getStart();
    return pos < lo || pos >= hi;
  });
}

/**
 * A declaration is unused iff it is not exported and has no reference outside
 * its own body. Returned in source order.
 */
export function findUnusedDeclarations(sourceFile: SourceFile): UnusedDeclaration[] {
  const result: UnusedDeclaration[] = [];

  for (const imp of sourceFile.getImportDeclarations()) {
    const defaultImport = imp.getDefaultImport();
    if (defaultImport && !hasOutsideReference(defaultImport, defaultImport)) {
      result.push({
        kind: "import",
        form: "default",
        name: defaultImport.getText(),
        start: defaultImport.getStart(),
        importDeclaration: imp,
      });
    }
    const ns = imp.getNamespaceImport();
    if (ns && !hasOutsideReference(ns, ns)) {
      result.push({
        kind: "import",
        form: "namespace",
        name: ns.getText(),
        start: ns.getStart(),
        importDeclaration: imp,
      });
    }
    for (const spec of imp.getNamedImports()) {
      const local = spec.getAliasNode() ?? spec.getNameNode();
      if (!Node.isIdentifier(local)) continue;
      if (!hasOutsideReference(local, spec)) {
        result.push({
          kind: "import",
          form: "named",
          name: local.getText(),
          start: spec.getStart(),
          importDeclaration: imp,
          specifier: spec,
        });
      }
    }
  }

  sourceFile.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node)) {
      const nameNode = node.getNameNode();
      if (!Node.isIdentifier(nameNode)) return;
      const list = node.getParent();
      const stmt = list?.getParent();
      if (!stmt || !Node.isVariableStatement(stmt)) return;
      if (stmt.isExported() || stmt.hasDeclareKeyword()) return;
      if (!hasOutsideReference(nameNode, node)) {
        result.push({
          kind: "variable",
          name: nameNode.getText(),
          start: node.getStart(),
          declaration: node,
        });
      }
    } else if (Node.isFunctionDeclaration(node)) {
      const nameNode = node.getNameNode();
      if (!nameNode) return;
      if (node.isExported() || node.isDefaultExport() || node.hasDeclareKeyword()) return;
      if (!node.hasBody() || node.getOverloads().length > 0) return;
      if (!hasOutsideReference(nameNode, node)) {
        result.push({
          kind: "function",
          name: nameNode.getText(),
          start: node.getStart(),
          declaration: node,
        });
      }
    }
  });

  return result.sort((a, b) => a.start - b.start);
}
