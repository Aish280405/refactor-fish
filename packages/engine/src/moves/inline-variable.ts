/**
 * Inline_Variable: replaces a `const` identifier that is referenced exactly once
 * with its initializer expression (Requirements 5.1 to 5.5).
 */
import { Node, SymbolFlags, SyntaxKind, VariableDeclarationKind, ts } from "ts-morph";
import type {
  Expression,
  Identifier,
  SourceFile,
  TypeChecker,
  VariableDeclaration,
  VariableDeclarationList,
} from "ts-morph";
import { AstEditor, safeApply } from "../ast-editor.js";
import type { Candidate, Position } from "../types.js";

// ---------------------------------------------------------------------------
// Syntax helpers
// ---------------------------------------------------------------------------

const K = SyntaxKind;

function isAssignmentKind(kind: SyntaxKind): boolean {
  return kind >= K.FirstAssignment && kind <= K.LastAssignment;
}

/** Nodes whose bodies are not executed when the node itself is evaluated. */
function isNonExecutedBoundary(kind: SyntaxKind): boolean {
  return (
    kind === K.FunctionDeclaration ||
    kind === K.FunctionExpression ||
    kind === K.ArrowFunction ||
    kind === K.MethodDeclaration ||
    kind === K.Constructor ||
    kind === K.GetAccessor ||
    kind === K.SetAccessor ||
    kind === K.ClassDeclaration ||
    kind === K.ClassExpression
  );
}

/** Function-like ancestors inside which a reference runs later (and possibly repeatedly). */
function isNestedFunctionKind(kind: SyntaxKind): boolean {
  return (
    kind === K.FunctionDeclaration ||
    kind === K.FunctionExpression ||
    kind === K.ArrowFunction ||
    kind === K.MethodDeclaration ||
    kind === K.Constructor ||
    kind === K.GetAccessor ||
    kind === K.SetAccessor ||
    kind === K.PropertyDeclaration ||
    kind === K.ClassStaticBlockDeclaration
  );
}

/**
 * True when evaluating `node` has a side effect per Requirement 5.3: a call,
 * `new`, `await`, `yield`, assignment, increment/decrement, `delete`, tagged
 * template, or a for-in/of loop assigning to an existing variable. Function and
 * class bodies are not entered because defining them executes nothing.
 * With `withJumps`, return/throw/break/continue also count (they can skip the
 * evaluation of a moved side-effecting initializer).
 */
function hasSideEffect(node: Node, withJumps: boolean): boolean {
  const kind = node.getKind();
  if (isNonExecutedBoundary(kind)) return false;
  switch (kind) {
    case K.CallExpression:
    case K.NewExpression:
    case K.AwaitExpression:
    case K.YieldExpression:
    case K.DeleteExpression:
    case K.TaggedTemplateExpression:
      return true;
    case K.BinaryExpression:
      if (isAssignmentKind((node as import("ts-morph").BinaryExpression).getOperatorToken().getKind())) {
        return true;
      }
      break;
    case K.PrefixUnaryExpression:
    case K.PostfixUnaryExpression: {
      const op = (node as import("ts-morph").PrefixUnaryExpression).getOperatorToken();
      if (op === K.PlusPlusToken || op === K.MinusMinusToken) return true;
      break;
    }
    case K.ForInStatement:
    case K.ForOfStatement: {
      const loop = node as import("ts-morph").ForOfStatement;
      if (!Node.isVariableDeclarationList(loop.getInitializer())) return true;
      if (Node.isForOfStatement(loop) && loop.isAwaited()) return true;
      break;
    }
    case K.ReturnStatement:
    case K.ThrowStatement:
    case K.BreakStatement:
    case K.ContinueStatement:
      if (withJumps) return true;
      break;
    default:
      break;
  }
  return node.forEachChildAsArray().some((child) => hasSideEffect(child, withJumps));
}

/** True when `node` is (part of) the target of an assignment, ++/--, or for-in/of head. */
function isWriteTarget(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    const p = cur.getParent();
    if (!p) return false;
    switch (p.getKind()) {
      case K.ParenthesizedExpression:
      case K.NonNullExpression:
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.TypeAssertionExpression:
      case K.ArrayLiteralExpression:
      case K.ObjectLiteralExpression:
      case K.ShorthandPropertyAssignment:
      case K.SpreadElement:
      case K.SpreadAssignment:
        cur = p;
        continue;
      case K.PropertyAssignment:
        if ((p as import("ts-morph").PropertyAssignment).getInitializer() !== cur) return false;
        cur = p;
        continue;
      case K.BinaryExpression: {
        const b = p as import("ts-morph").BinaryExpression;
        return isAssignmentKind(b.getOperatorToken().getKind()) && b.getLeft() === cur;
      }
      case K.PrefixUnaryExpression:
      case K.PostfixUnaryExpression: {
        const op = (p as import("ts-morph").PrefixUnaryExpression).getOperatorToken();
        return op === K.PlusPlusToken || op === K.MinusMinusToken;
      }
      case K.ForInStatement:
      case K.ForOfStatement:
        return (p as import("ts-morph").ForOfStatement).getInitializer() === cur;
      default:
        return false;
    }
  }
}

/** Symbol an identifier refers to, resolving shorthand properties and export specifiers. */
function symbolOf(checker: TypeChecker, id: Identifier): ts.Symbol | undefined {
  const p = id.getParent();
  if (p && Node.isShorthandPropertyAssignment(p) && p.getNameNode() === id) {
    return checker.getShorthandAssignmentValueSymbol(p)?.compilerSymbol;
  }
  if (p && Node.isExportSpecifier(p)) {
    if (p.getNameNode() !== id) return undefined;
    return checker.getExportSpecifierLocalTargetSymbol(p)?.compilerSymbol;
  }
  return checker.getSymbolAtLocation(id)?.compilerSymbol;
}

function sameSymbol(a: ts.Symbol, b: ts.Symbol): boolean {
  if (a === b) return true;
  const da = a.declarations?.[0];
  const db = b.declarations?.[0];
  return da !== undefined && da === db;
}

// ---------------------------------------------------------------------------
// Eligibility analysis
// ---------------------------------------------------------------------------

interface Plan {
  decl: VariableDeclaration;
  name: string;
  init: Expression;
  ref: Identifier;
}

interface Nesting {
  /** Reference runs inside a nested function (or class member initializer). */
  inFunction: boolean;
  /** ...and that function is not an arrow function (own `this`/`arguments`). */
  inNonArrowFunction: boolean;
  /** Loops whose repeated part contains the reference. */
  loops: Node[];
  /** Reference is in a conditionally evaluated branch. */
  inConditional: boolean;
}

function nestingOf(ref: Node, container: Node): Nesting {
  const result: Nesting = { inFunction: false, inNonArrowFunction: false, loops: [], inConditional: false };
  let child: Node = ref;
  for (let a = ref.getParent(); a && a !== container; child = a, a = a.getParent()) {
    const kind = a.getKind();
    if (isNestedFunctionKind(kind)) {
      result.inFunction = true;
      if (kind !== K.ArrowFunction) result.inNonArrowFunction = true;
    } else if (kind === K.ForStatement) {
      if ((a as import("ts-morph").ForStatement).getInitializer() !== child) result.loops.push(a);
    } else if (kind === K.ForInStatement || kind === K.ForOfStatement) {
      if ((a as import("ts-morph").ForOfStatement).getExpression() !== child) result.loops.push(a);
    } else if (kind === K.WhileStatement || kind === K.DoStatement) {
      result.loops.push(a);
    } else if (kind === K.IfStatement) {
      const s = a as import("ts-morph").IfStatement;
      if (child === s.getThenStatement() || child === s.getElseStatement()) result.inConditional = true;
    } else if (kind === K.ConditionalExpression) {
      const c = a as import("ts-morph").ConditionalExpression;
      if (child === c.getWhenTrue() || child === c.getWhenFalse()) result.inConditional = true;
    } else if (kind === K.BinaryExpression) {
      const b = a as import("ts-morph").BinaryExpression;
      const op = b.getOperatorToken().getKind();
      if (
        (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken) &&
        b.getRight() === child
      ) {
        result.inConditional = true;
      }
    } else if (kind === K.CaseClause || kind === K.DefaultClause) {
      if (Node.isStatement(child)) result.inConditional = true;
    }
  }
  return result;
}

/** Siblings that are mutually exclusive with the branch containing the reference. */
function isExcludedAlternative(parent: Node, child: Node, sibling: Node): boolean {
  if (Node.isIfStatement(parent)) {
    return child === parent.getElseStatement() && sibling === parent.getThenStatement();
  }
  if (Node.isConditionalExpression(parent)) {
    return child === parent.getWhenFalse() && sibling === parent.getWhenTrue();
  }
  return false;
}

/**
 * Walks from the reference up to the declaration's container, scanning every
 * node evaluated after the declaration and before the reference (source order)
 * for side effects (Requirement 5.3).
 */
function pathHasSideEffects(
  decl: VariableDeclaration,
  ref: Node,
  container: Node,
  initHasEffects: boolean,
): boolean {
  const declEnd = decl.getEnd();
  let child: Node = ref;
  for (;;) {
    const parent = child.getParent();
    if (!parent) return true;
    for (const sibling of parent.forEachChildAsArray()) {
      if (sibling === child) break;
      if (sibling.getStart() < declEnd) continue;
      if (isExcludedAlternative(parent, child, sibling)) continue;
      if (hasSideEffect(sibling, initHasEffects)) return true;
    }
    if (parent === container) return false;
    child = parent;
  }
}

function identifiersIn(node: Node): Identifier[] {
  const ids = node.getDescendantsOfKind(K.Identifier);
  return Node.isIdentifier(node) ? [node, ...ids] : ids;
}

function usesThisLike(init: Node): boolean {
  const nodes = [init, ...init.getDescendants()];
  return nodes.some(
    (n) =>
      n.getKind() === K.ThisKeyword ||
      n.getKind() === K.SuperKeyword ||
      n.getKind() === K.MetaProperty ||
      (Node.isIdentifier(n) && n.getText() === "arguments"),
  );
}

/** True when a name used by the initializer would resolve differently at the reference site. */
function isShadowedAtReference(checker: TypeChecker, init: Expression, ref: Identifier): boolean {
  let inScope: ts.Symbol[] | undefined;
  for (const id of identifiersIn(init)) {
    const sym = symbolOf(checker, id);
    if (!sym) continue;
    if (sym.flags & (SymbolFlags.Property | SymbolFlags.Method | SymbolFlags.Accessor | SymbolFlags.EnumMember)) {
      continue;
    }
    const decls = sym.declarations ?? [];
    if (decls.length > 0 && decls.every((d) => d.pos >= init.getPos() && d.end <= init.getEnd())) continue;
    inScope ??= checker
      .getSymbolsInScope(ref, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias)
      .map((s) => s.compilerSymbol);
    const found = inScope.find((s) => s.getName() === id.getText());
    if (found && !sameSymbol(found, sym)) return true;
  }
  return false;
}

/** True when any variable read by the initializer is written inside one of `loops`. */
function readVariableWrittenInLoops(
  checker: TypeChecker,
  init: Expression,
  loops: Node[],
): boolean {
  const reads = new Map<string, ts.Symbol>();
  for (const id of identifiersIn(init)) {
    const sym = symbolOf(checker, id);
    if (sym && sym.flags & SymbolFlags.Variable) reads.set(id.getText(), sym);
  }
  if (reads.size === 0) return false;
  for (const loop of loops) {
    for (const id of loop.getDescendantsOfKind(K.Identifier)) {
      const sym = reads.get(id.getText());
      if (!sym || !isWriteTarget(id)) continue;
      const other = symbolOf(checker, id);
      if (other && sameSymbol(other, sym)) return true;
    }
  }
  return false;
}

/** Returns the inlining plan for `decl`, or undefined when it is not eligible. */
function analyze(sf: SourceFile, checker: TypeChecker, decl: VariableDeclaration): Plan | undefined {
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return undefined; // destructuring pattern
  const init = decl.getInitializer();
  if (!init) return undefined;

  const list = decl.getParent();
  if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) {
    return undefined;
  }
  const stmt = list.getParent();
  if (!Node.isVariableStatement(stmt)) return undefined; // e.g. a for-loop head
  if (stmt.hasExportKeyword() || stmt.hasDeclareKeyword()) return undefined;
  const container = stmt.getParent();
  if (
    !container ||
    !(
      Node.isSourceFile(container) ||
      Node.isBlock(container) ||
      Node.isModuleBlock(container) ||
      Node.isCaseClause(container) ||
      Node.isDefaultClause(container)
    )
  ) {
    return undefined;
  }

  const declSym = checker.getSymbolAtLocation(nameNode)?.compilerSymbol;
  if (!declSym) return undefined;
  const name = nameNode.getText();

  // Requirement 5.1: exactly one reference outside the declaration itself.
  const refs = sf.getDescendantsOfKind(K.Identifier).filter((id) => {
    if (id === nameNode || id.getText() !== name) return false;
    const sym = symbolOf(checker, id);
    return sym !== undefined && sameSymbol(sym, declSym);
  });
  if (refs.length !== 1) return undefined;
  const ref = refs[0]!;

  // Requirement 5.4: exported via specifier or default export.
  const refParent = ref.getParent();
  if (!refParent) return undefined;
  const refParentKind = refParent.getKind();
  if (refParentKind === K.ExportSpecifier || refParentKind === K.ExportAssignment) return undefined;
  // Positions where an arbitrary expression cannot be substituted.
  if (
    refParentKind === K.JsxOpeningElement ||
    refParentKind === K.JsxSelfClosingElement ||
    refParentKind === K.JsxClosingElement ||
    ref.getFirstAncestorByKind(K.TypeQuery) !== undefined ||
    isWriteTarget(ref)
  ) {
    return undefined;
  }
  // The reference must come after the declaration within its container.
  if (ref.getStart() < decl.getEnd() || !ref.getAncestors().includes(container)) return undefined;

  const initHasEffects = hasSideEffect(init, false);
  const nesting = nestingOf(ref, container);

  // Requirement 5.5.
  if (initHasEffects && (nesting.inFunction || nesting.loops.length > 0 || nesting.inConditional)) {
    return undefined;
  }
  // Requirement 5.3.
  if (pathHasSideEffects(decl, ref, container, initHasEffects)) return undefined;
  // Variables the initializer reads must not change while a loop re-evaluates the reference.
  if (nesting.loops.length > 0 && readVariableWrittenInLoops(checker, init, nesting.loops)) return undefined;
  // `this`/`arguments` would rebind inside a nested non-arrow function.
  if (nesting.inNonArrowFunction && usesThisLike(init)) return undefined;
  // Names used by the initializer must resolve the same way at the reference.
  if (isShadowedAtReference(checker, init, ref)) return undefined;

  return { decl, name, init, ref };
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

function binaryPrecedence(op: SyntaxKind): number {
  switch (op) {
    case K.CommaToken:
      return 1;
    case K.QuestionQuestionToken:
    case K.BarBarToken:
      return 4;
    case K.AmpersandAmpersandToken:
      return 5;
    case K.BarToken:
      return 6;
    case K.CaretToken:
      return 7;
    case K.AmpersandToken:
      return 8;
    case K.EqualsEqualsToken:
    case K.ExclamationEqualsToken:
    case K.EqualsEqualsEqualsToken:
    case K.ExclamationEqualsEqualsToken:
      return 9;
    case K.LessThanToken:
    case K.GreaterThanToken:
    case K.LessThanEqualsToken:
    case K.GreaterThanEqualsToken:
    case K.InstanceOfKeyword:
    case K.InKeyword:
      return 10;
    case K.LessThanLessThanToken:
    case K.GreaterThanGreaterThanToken:
    case K.GreaterThanGreaterThanGreaterThanToken:
      return 11;
    case K.PlusToken:
    case K.MinusToken:
      return 12;
    case K.AsteriskToken:
    case K.SlashToken:
    case K.PercentToken:
      return 13;
    case K.AsteriskAsteriskToken:
      return 14;
    default:
      return isAssignmentKind(op) ? 2 : 12;
  }
}

/** Operator precedence of an expression: higher binds tighter. Member/call/primary is 18. */
function expressionPrecedence(e: Node): number {
  switch (e.getKind()) {
    case K.BinaryExpression:
      return binaryPrecedence((e as import("ts-morph").BinaryExpression).getOperatorToken().getKind());
    case K.ConditionalExpression:
      return 3;
    case K.ArrowFunction:
    case K.YieldExpression:
      return 2;
    case K.AsExpression:
    case K.SatisfiesExpression:
      return 10;
    case K.PrefixUnaryExpression:
    case K.TypeOfExpression:
    case K.VoidExpression:
    case K.DeleteExpression:
    case K.AwaitExpression:
    case K.TypeAssertionExpression:
      return 15;
    case K.PostfixUnaryExpression:
      return 16;
    case K.NewExpression:
      // `new Foo` without an argument list binds looser than a member access.
      return (e.compilerNode as ts.NewExpression).arguments === undefined ? 16 : 18;
    default:
      return 18;
  }
}

/** Minimum precedence an expression needs to stand in the reference's position unparenthesized. */
function requiredPrecedence(ref: Node): number {
  const p = ref.getParent();
  if (!p) return 17;
  switch (p.getKind()) {
    case K.BinaryExpression: {
      const b = p as import("ts-morph").BinaryExpression;
      const op = b.getOperatorToken().getKind();
      const isLeft = b.getLeft() === ref;
      if (op === K.CommaToken) return 1;
      if (isAssignmentKind(op)) return isLeft ? 17 : 2;
      if (op === K.AsteriskAsteriskToken) return isLeft ? 16 : 14;
      const pp = binaryPrecedence(op);
      return isLeft ? pp : pp + 1;
    }
    case K.PrefixUnaryExpression:
    case K.TypeOfExpression:
    case K.VoidExpression:
    case K.DeleteExpression:
    case K.AwaitExpression:
    case K.TypeAssertionExpression:
      return 15;
    case K.CallExpression:
    case K.NewExpression:
      return (p as import("ts-morph").CallExpression).getExpression() === ref ? 17 : 2;
    case K.ElementAccessExpression:
      return (p as import("ts-morph").ElementAccessExpression).getExpression() === ref ? 17 : 0;
    case K.TaggedTemplateExpression:
      return (p as import("ts-morph").TaggedTemplateExpression).getTag() === ref ? 17 : 0;
    case K.ConditionalExpression:
      return (p as import("ts-morph").ConditionalExpression).getCondition() === ref ? 4 : 2;
    case K.AsExpression:
    case K.SatisfiesExpression:
      return 10;
    case K.SpreadElement:
    case K.SpreadAssignment:
    case K.YieldExpression:
    case K.ArrowFunction:
    case K.PropertyAssignment:
    case K.ArrayLiteralExpression:
    case K.VariableDeclaration:
    case K.Parameter:
    case K.BindingElement:
    case K.PropertyDeclaration:
    case K.EnumMember:
    case K.ForOfStatement:
    case K.ForInStatement:
      return 2;
    case K.ParenthesizedExpression:
    case K.ExpressionStatement:
    case K.ReturnStatement:
    case K.ThrowStatement:
    case K.IfStatement:
    case K.WhileStatement:
    case K.DoStatement:
    case K.SwitchStatement:
    case K.CaseClause:
    case K.TemplateSpan:
    case K.ComputedPropertyName:
    case K.JsxExpression:
    case K.ForStatement:
      return 0;
    default:
      // PropertyAccess, NonNull, PostfixUnary, heritage clauses, and anything unknown.
      return 17;
  }
}

const NULLISH = K.QuestionQuestionToken;

function isLogicalAndOr(op: SyntaxKind): boolean {
  return op === K.BarBarToken || op === K.AmpersandAmpersandToken;
}

/** True when the leftmost token of `ref` would begin an expression statement (or a concise arrow body). */
function startsStatement(ref: Node, text: string): boolean {
  let n: Node = ref;
  for (;;) {
    const p = n.getParent();
    if (!p) return false;
    if (Node.isExpressionStatement(p)) return true;
    if (Node.isArrowFunction(p) && p.getBody() === n) return text.startsWith("{");
    if (p.getStart() !== n.getStart() || Node.isStatement(p)) return false;
    n = p;
  }
}

function needsParentheses(init: Expression, ref: Identifier, shorthand: boolean): boolean {
  const text = init.getText();
  const min = shorthand ? 2 : requiredPrecedence(ref);
  if (expressionPrecedence(init) < min) return true;
  if (shorthand) return false;

  const parent = ref.getParent()!;
  if (Node.isBinaryExpression(init) && Node.isBinaryExpression(parent)) {
    const a = init.getOperatorToken().getKind();
    const b = parent.getOperatorToken().getKind();
    // `??` cannot be mixed with `||`/`&&` without parentheses.
    if ((a === NULLISH && isLogicalAndOr(b)) || (b === NULLISH && isLogicalAndOr(a))) return true;
  }
  // `- -x` would print as `--x`.
  if (Node.isPrefixUnaryExpression(parent) && /^[+-]/.test(text)) return true;
  if (min === 17) {
    // `(a?.b).c` differs from `a?.b.c`.
    if ((init.compilerNode.flags & ts.NodeFlags.OptionalChain) !== 0) return true;
    // `1.toString()` is a syntax error.
    if (Node.isNumericLiteral(init) && Node.isPropertyAccessExpression(parent)) return true;
  }
  // `new f()()` would change meaning.
  if (Node.isNewExpression(parent) && parent.getExpression() === ref) {
    const simple =
      Node.isIdentifier(init) ||
      (Node.isPropertyAccessExpression(init) &&
        init.getDescendantsOfKind(K.CallExpression).length === 0 &&
        (init.compilerNode.flags & ts.NodeFlags.OptionalChain) === 0);
    if (!simple) return true;
  }
  // `{`, `function`, `class` at the start of a statement would be parsed as a declaration or block.
  if (/^(\{|function\b|class\b|async\s+function\b)/.test(text) && startsStatement(ref, text)) return true;
  return false;
}

function applyPlan(plan: Plan): void {
  const { decl, init, ref } = plan;
  const parent = ref.getParent()!;
  const shorthand = Node.isShorthandPropertyAssignment(parent);
  const raw = init.getText();
  const value = needsParentheses(init, ref, shorthand) ? `(${raw})` : raw;
  if (Node.isShorthandPropertyAssignment(parent)) {
    parent.replaceWithText(`${ref.getText()}: ${value}`);
  } else {
    ref.replaceWithText(value);
  }
  const list = decl.getParent() as VariableDeclarationList;
  if (list.getDeclarations().length === 1) {
    (list.getParent() as import("ts-morph").VariableStatement).remove();
  } else {
    decl.remove();
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function findDeclaration(sf: SourceFile, name: string, start: number): VariableDeclaration | undefined {
  return sf
    .getDescendantsOfKind(K.VariableDeclaration)
    .find((d) => d.getStart() === start && d.getName() === name);
}

function makeCandidate(name: string, start: number): Candidate {
  return {
    move: "InlineVariable",
    displayName: "Inline variable",
    describe: () => `Inline variable '${name}'`,
    apply: (position: Position) =>
      safeApply(position, (unit) => {
        const sf = unit.getSourceFile();
        const decl = findDeclaration(sf, name, start);
        if (!decl) throw new Error(`Variable '${name}' not found at the expected location`);
        const plan = analyze(sf, unit.getTypeChecker(), decl);
        if (!plan) throw new Error(`Inline_Variable is not applicable to '${name}'`);
        applyPlan(plan);
      }),
  };
}

/** One candidate per eligible declarator, in source order (by declarator start). */
export function generateInlineVariable(position: Position): Candidate[] {
  try {
    const unit = AstEditor.load(position);
    const sf = unit.getSourceFile();
    const checker = unit.getTypeChecker();
    const candidates: Candidate[] = [];
    for (const decl of sf.getDescendantsOfKind(K.VariableDeclaration)) {
      if (analyze(sf, checker, decl)) candidates.push(makeCandidate(decl.getName(), decl.getStart()));
    }
    return candidates;
  } catch {
    return [];
  }
}

export const InlineVariableGenerator = {
  generate(position: Position): Candidate[] {
    return generateInlineVariable(position);
  },
};
