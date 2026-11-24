import { Node, SyntaxKind, ts } from "ts-morph";
import type { Expression, IfStatement, SourceFile, Statement, Type } from "ts-morph";
import { safeApply } from "../ast-editor.js";
import type { EditableUnit } from "../ast-editor.js";
import { AstEditor } from "../ast-editor.js";
import type { Candidate, Position } from "../types.js";

type FunctionLike = Node & {
  getBody(): Node | undefined;
  getReturnType(): Type;
  getParameters(): Node[];
  isAsync(): boolean;
  isGenerator?(): boolean;
};

interface GuardSite {
  ifStmt: IfStatement;
  fn: FunctionLike;
  fnName: string;
  /** Source of the early return statement, e.g. `return;`. */
  earlyReturn: string;
  /** The following `return` statement, if any. */
  followingReturn?: Statement;
}

const FUNCTION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
]);

function isFunctionLike(node: Node): node is FunctionLike {
  return FUNCTION_KINDS.has(node.getKind());
}

function functionName(fn: FunctionLike): string {
  const named = fn as unknown as { getName?: () => string | undefined };
  const own = named.getName?.();
  if (own) return own;
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return "anonymous function";
}

function identifierNames(node: Node): string[] {
  const names: string[] = [];
  if (Node.isIdentifier(node)) names.push(node.getText());
  for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) names.push(id.getText());
  return names;
}

function nearestFunction(node: Node): Node | undefined {
  return node.getFirstAncestor((a) => isFunctionLike(a) || Node.isConstructorDeclaration(a));
}

/** Names already declared in the function scope (params, direct declarations, hoisted vars). */
function enclosingNames(fn: FunctionLike, body: Node & { getStatements(): Statement[] }, skip: Node): Set<string> {
  const names = new Set<string>();
  for (const p of fn.getParameters()) {
    const nameNode = (p as unknown as { getNameNode(): Node }).getNameNode();
    for (const n of identifierNames(nameNode)) names.add(n);
  }
  for (const st of body.getStatements()) {
    if (st === skip) continue;
    if (Node.isVariableStatement(st)) {
      for (const d of st.getDeclarations()) for (const n of identifierNames(d.getNameNode())) names.add(n);
    } else if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) {
      const n = st.getName();
      if (n) names.add(n);
    }
  }
  for (const d of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const list = d.getParent();
    if (
      list &&
      Node.isVariableDeclarationList(list) &&
      !(list.getFlags() & (ts.NodeFlags.Let | ts.NodeFlags.Const)) &&
      nearestFunction(d) === fn &&
      !skip.containsRange(d.getPos(), d.getEnd())
    ) {
      for (const n of identifierNames(d.getNameNode())) names.add(n);
    }
  }
  return names;
}

/** Names the `if` body would declare at function level once unwrapped. */
function unwrappedDeclarations(thenStmt: Statement): string[] {
  if (!Node.isBlock(thenStmt)) return [];
  const names: string[] = [];
  for (const st of thenStmt.getStatements()) {
    if (Node.isVariableStatement(st)) {
      const list = st.getDeclarationList();
      if (list.getFlags() & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
        for (const d of st.getDeclarations()) names.push(...identifierNames(d.getNameNode()));
      }
    } else if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) {
      const n = st.getName();
      if (n) names.push(n);
    }
  }
  return names;
}

function isVoidLike(type: Type): boolean {
  if (type.getFlags() & ts.TypeFlags.Void) return true;
  return type.isUnion() && type.getUnionTypes().some((t) => (t.getFlags() & ts.TypeFlags.Void) !== 0);
}

function includesUndefined(type: Type): boolean {
  const mask = ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  if (type.getFlags() & mask) return true;
  return type.isUnion() && type.getUnionTypes().some((t) => (t.getFlags() & mask) !== 0);
}

function effectiveReturnType(fn: FunctionLike): Type {
  const type = fn.getReturnType();
  if (fn.isAsync() && type.getSymbol()?.getName() === "Promise") {
    const arg = type.getTypeArguments()[0];
    if (arg) return arg;
  }
  return type;
}

function analyzeIf(ifStmt: IfStatement): GuardSite | undefined {
  if (ifStmt.getElseStatement()) return undefined;
  const block = ifStmt.getParent();
  if (!block || !Node.isBlock(block)) return undefined;
  const fn = block.getParent();
  if (!fn || !isFunctionLike(fn) || fn.getBody() !== block) return undefined;
  if (fn.isGenerator?.()) return undefined;

  const statements = block.getStatements();
  const idx = statements.indexOf(ifStmt);
  const rest = statements.slice(idx + 1);
  if (rest.length > 1) return undefined;
  const following = rest[0];
  if (following && !Node.isReturnStatement(following)) return undefined;

  let earlyReturn: string;
  if (following && Node.isReturnStatement(following)) {
    const expr = following.getExpression();
    earlyReturn = expr ? `return ${expr.getText()};` : "return;";
  } else {
    const type = effectiveReturnType(fn);
    if (isVoidLike(type)) earlyReturn = "return;";
    else if (includesUndefined(type)) earlyReturn = "return undefined;";
    else return undefined;
  }

  const existing = enclosingNames(fn, block, ifStmt);
  if (unwrappedDeclarations(ifStmt.getThenStatement()).some((n) => existing.has(n))) return undefined;

  return { ifStmt, fn, fnName: functionName(fn), earlyReturn, followingReturn: following };
}

function findSites(sourceFile: SourceFile): GuardSite[] {
  const sites: GuardSite[] = [];
  for (const ifStmt of sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const site = analyzeIf(ifStmt);
    if (site) sites.push(site);
  }
  return sites.sort((a, b) => a.ifStmt.getStart() - b.ifStmt.getStart());
}

const SIMPLE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.CallExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.ThisKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
]);

function negate(cond: Expression): string {
  if (
    Node.isPrefixUnaryExpression(cond) &&
    cond.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    let operand: Expression = cond.getOperand();
    while (Node.isParenthesizedExpression(operand)) operand = operand.getExpression();
    return operand.getText();
  }
  const text = cond.getText();
  return SIMPLE_KINDS.has(cond.getKind()) ? `!${text}` : `!(${text})`;
}

function hasMultilineTemplate(node: Node): boolean {
  const kinds = [SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateExpression];
  return kinds.some((k) => node.getDescendantsOfKind(k).some((t) => t.getText().includes("\n")));
}

/** Re-indents the text between braces so it sits at `baseIndent`. */
function unwrapText(thenStmt: Statement, baseIndent: string): string {
  if (!Node.isBlock(thenStmt)) return baseIndent + thenStmt.getText();
  const full = thenStmt.getText();
  const inner = full.slice(1, full.length - 1);
  const firstNewline = inner.indexOf("\n");
  if (firstNewline === -1) {
    const t = inner.trim();
    return t ? baseIndent + t : "";
  }
  const head = inner.slice(0, firstNewline).trim();
  const lines = inner.slice(firstNewline + 1).split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const out: string[] = [];
  if (head) out.push(baseIndent + head);
  if (hasMultilineTemplate(thenStmt)) {
    out.push(...lines);
  } else {
    const indents = lines
      .filter((l) => l.trim() !== "")
      .map((l) => l.length - l.trimStart().length);
    const min = indents.length > 0 ? Math.min(...indents) : 0;
    for (const l of lines) out.push(l.trim() === "" ? "" : baseIndent + l.slice(min).trimEnd());
  }
  return out.join("\n");
}

function endsTerminated(thenStmt: Statement): boolean {
  const last = Node.isBlock(thenStmt) ? thenStmt.getStatements().at(-1) : thenStmt;
  return !!last && (Node.isReturnStatement(last) || Node.isThrowStatement(last));
}

function applySite(unit: EditableUnit, ifStart: number): void {
  const sourceFile = unit.getSourceFile();
  const site = findSites(sourceFile).find((s) => s.ifStmt.getStart() === ifStart);
  if (!site) throw new Error("Guard clause is no longer applicable at this location");

  const { ifStmt, earlyReturn, followingReturn } = site;
  const text = sourceFile.getFullText();
  const start = ifStmt.getStart();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const prefix = text.slice(lineStart, start);
  const baseIndent = prefix.trim() === "" ? prefix : "";

  const thenStmt = ifStmt.getThenStatement();
  const body = unwrapText(thenStmt, baseIndent);
  const replacement =
    `if (${negate(ifStmt.getExpression())}) ${earlyReturn}` + (body ? `\n${body}` : "");

  let result: string;
  const dropReturn = followingReturn !== undefined && endsTerminated(thenStmt);
  if (dropReturn && followingReturn) {
    const ifEnd = ifStmt.getEnd();
    const retStart = followingReturn.getStart();
    const retEnd = followingReturn.getEnd();
    if (text.slice(ifEnd, retStart).trim() === "") {
      result = text.slice(0, start) + replacement + text.slice(retEnd);
    } else {
      result =
        text.slice(0, start) + replacement + text.slice(ifEnd, retStart) + text.slice(retEnd);
    }
  } else {
    result = text.slice(0, start) + replacement + text.slice(ifStmt.getEnd());
  }
  sourceFile.replaceWithText(result);
}

function makeCandidate(site: GuardSite): Candidate {
  const ifStart = site.ifStmt.getStart();
  const condText = site.ifStmt.getExpression().getText().replace(/\s+/g, " ");
  const description = `Convert if (${condText}) in ${site.fnName}() to a guard clause`;
  return {
    move: "GuardClause",
    displayName: "Guard clause",
    describe: () => description,
    apply: (position: Position) => safeApply(position, (unit) => applySite(unit, ifStart)),
  };
}

/** Deterministic Guard_Clause candidates, in source order of the `if` statements. */
export function generateGuardClauseCandidates(position: Position): Candidate[] {
  try {
    const unit = AstEditor.load(position);
    return findSites(unit.getSourceFile()).map(makeCandidate);
  } catch {
    return [];
  }
}

export const GuardClauseGenerator = {
  generate(position: Position): Candidate[] {
    return generateGuardClauseCandidates(position);
  },
};
