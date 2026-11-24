import { Node, SyntaxKind } from "ts-morph";
import type { Type } from "ts-morph";
import { AstEditor, safeApply } from "../ast-editor.js";
import type { EditableUnit } from "../ast-editor.js";
import type { ApplyResult, Candidate, Position } from "../types.js";

type SiteKind = "strict-equals-true" | "double-negation" | "if-return-bool";

interface Site {
  kind: SiteKind;
  node: Node;
  start: number;
  end: number;
  /** Text that replaces the node's text (node.getStart()..node.getEnd()). */
  replacement: string;
  description: string;
}

const KIND_ORDER: Record<SiteKind, number> = {
  "strict-equals-true": 0,
  "double-negation": 1,
  "if-return-bool": 2,
};

/** True only when the type is exactly `boolean` (or `true`/`false`); false for any, unknown, unions with other members. */
function isExactlyBoolean(type: Type): boolean {
  return type.isBoolean() || type.isBooleanLiteral();
}

function typeIsBoolean(unit: EditableUnit, node: Node): boolean {
  try {
    return isExactlyBoolean(unit.getTypeChecker().getTypeAtLocation(node));
  } catch {
    return false;
  }
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ");
  return t.length > 40 ? `${t.slice(0, 37)}...` : t;
}

/** Walks up through parentheses; returns the outermost wrapper of `node` and its parent. */
function skipParens(node: Node): { child: Node; parent: Node | undefined } {
  let child = node;
  let parent = node.getParent();
  while (parent && Node.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.getParent();
  }
  return { child, parent };
}

/** `node` is directly an if/while/ternary condition, or an &&/|| operand whose result is one. */
function isInBooleanContext(node: Node): boolean {
  const { child, parent } = skipParens(node);
  if (!parent) return false;
  if (Node.isIfStatement(parent)) return parent.getExpression() === child;
  if (Node.isWhileStatement(parent)) return parent.getExpression() === child;
  if (Node.isConditionalExpression(parent)) return parent.getCondition() === child;
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getKind();
    if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) {
      return isInBooleanContext(parent);
    }
  }
  return false;
}

function isAndOrOperand(node: Node): boolean {
  const { parent } = skipParens(node);
  if (!parent || !Node.isBinaryExpression(parent)) return false;
  const op = parent.getOperatorToken().getKind();
  return op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken;
}

/** Returns `true`/`false` when the branch is `return true;`/`return false;` (optionally braced). */
function branchBoolean(stmt: Node | undefined): boolean | undefined {
  if (!stmt) return undefined;
  let s: Node = stmt;
  if (Node.isBlock(s)) {
    const inner = s.getStatements();
    if (inner.length !== 1) return undefined;
    s = inner[0]!;
  }
  if (!Node.isReturnStatement(s)) return undefined;
  const expr = s.getExpression();
  if (!expr) return undefined;
  if (expr.getKind() === SyntaxKind.TrueKeyword) return true;
  if (expr.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function findSites(unit: EditableUnit): Site[] {
  const sites: Site[] = [];
  unit.getSourceFile().forEachDescendant((node) => {
    // x === true
    if (Node.isBinaryExpression(node)) {
      if (
        node.getOperatorToken().getKind() === SyntaxKind.EqualsEqualsEqualsToken &&
        node.getRight().getKind() === SyntaxKind.TrueKeyword
      ) {
        const left = node.getLeft();
        if (typeIsBoolean(unit, left)) {
          sites.push({
            kind: "strict-equals-true",
            node,
            start: node.getStart(),
            end: node.getEnd(),
            replacement: left.getText(),
            description: `Simplify '${oneLine(node.getText())}' to '${oneLine(left.getText())}'`,
          });
        }
      }
      return;
    }

    // !!x in a boolean context
    if (
      Node.isPrefixUnaryExpression(node) &&
      node.getOperatorToken() === SyntaxKind.ExclamationToken
    ) {
      const inner = node.getOperand();
      if (
        Node.isPrefixUnaryExpression(inner) &&
        inner.getOperatorToken() === SyntaxKind.ExclamationToken
      ) {
        const x = inner.getOperand();
        const allowed =
          isInBooleanContext(node) || (isAndOrOperand(node) && typeIsBoolean(unit, x));
        if (allowed) {
          sites.push({
            kind: "double-negation",
            node,
            start: node.getStart(),
            end: node.getEnd(),
            replacement: x.getText(),
            description: `Simplify '${oneLine(node.getText())}' to '${oneLine(x.getText())}'`,
          });
        }
      }
      return;
    }

    // if (c) return true; else return false;
    if (Node.isIfStatement(node)) {
      const elseStmt = node.getElseStatement();
      if (
        elseStmt &&
        branchBoolean(node.getThenStatement()) === true &&
        branchBoolean(elseStmt) === false
      ) {
        const cond = node.getExpression();
        if (typeIsBoolean(unit, cond)) {
          sites.push({
            kind: "if-return-bool",
            node,
            start: node.getStart(),
            end: node.getEnd(),
            replacement: `return ${cond.getText()};`,
            description: `Simplify 'if (${oneLine(cond.getText())}) return true; else return false;' to 'return ${oneLine(cond.getText())};'`,
          });
        }
      }
    }
  });

  sites.sort(
    (a, b) =>
      a.start - b.start || a.end - b.end || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
  return sites;
}

function applySite(position: Position, kind: SiteKind, start: number, end: number): ApplyResult {
  return safeApply(position, (unit) => {
    const site = findSites(unit).find(
      (s) => s.kind === kind && s.start === start && s.end === end,
    );
    if (!site) {
      throw new Error("Simplify_Boolean site not found in this Position");
    }
    site.node.replaceWithText(site.replacement);
  });
}

/**
 * Generates one candidate per Simplify_Boolean rewrite site, in source order.
 * Pure: never mutates `position`.
 */
export function generateSimplifyBoolean(position: Position): Candidate[] {
  let sites: Site[];
  try {
    sites = findSites(AstEditor.load(position));
  } catch {
    return [];
  }
  return sites.map((site): Candidate => {
    const { kind, start, end, description } = site;
    return {
      move: "SimplifyBoolean",
      displayName: "Simplify boolean",
      describe: () => description,
      apply: (p: Position) => applySite(p, kind, start, end),
    };
  });
}
