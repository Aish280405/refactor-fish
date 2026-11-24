import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { AstEditor } from "../ast-editor.js";
import { findUnusedDeclarations } from "../moves/unused-classifier.js";
import type { Metrics, Position } from "../types.js";

/** Per-function measurements (Requirements 13.1, 13.4, 13.5, 13.6). */
export interface FunctionMetrics {
  /** Function name if one can be determined, otherwise "<anonymous>". */
  name: string;
  kind: string;
  /** 1-based line of the first token of the function (excluding leading comments). */
  startLine: number;
  /** 1-based line of the last token of the function. */
  endLine: number;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  functionLength: number;
}

export interface MetricsReport {
  /** File totals: per-function metrics summed, plus whole-file duplicated and unused code. */
  metrics: Metrics;
  /** One entry per function, in source order of the function's start. */
  functions: FunctionMetrics[];
}

const FUNCTION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/** Constructs that add 1 to cyclomatic complexity (Requirement 13.4), except binary operators. */
const DECISION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
]);

const LOGICAL_OPERATORS = new Set<SyntaxKind>([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Control structures counted for nesting depth (Requirement 13.5). */
const CONTROL_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
]);

const STATEMENT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.Block,
  SyntaxKind.EmptyStatement,
  SyntaxKind.VariableStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.IfStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ContinueStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.WithStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.DebuggerStatement,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.ExportAssignment,
]);

export function isFunctionNode(node: Node): boolean {
  return FUNCTION_KINDS.has(node.getKind());
}

function functionName(fn: Node): string {
  if (fn.getKind() === SyntaxKind.Constructor) return "constructor";
  const nameNode = (fn as Node & { getNameNode?: () => Node | undefined }).getNameNode?.();
  if (nameNode) return nameNode.getText();
  const parent = fn.getParent();
  if (parent && (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent) ||
      Node.isPropertyDeclaration(parent))) {
    return parent.getNameNode().getText();
  }
  return "<anonymous>";
}

/**
 * Visits every descendant of `fn` (parameters and body) that belongs to `fn`
 * itself, i.e. without entering nested functions. `depth` is the number of
 * control structures enclosing the visited node within `fn`.
 */
function walkOwn(fn: Node, visit: (node: Node, depth: number) => void): void {
  const recurse = (node: Node, depth: number): void => {
    node.forEachChild((child) => {
      if (isFunctionNode(child)) return;
      visit(child, depth);
      recurse(child, CONTROL_KINDS.has(child.getKind()) ? depth + 1 : depth);
    });
  };
  recurse(fn, 0);
}

export function measureFunction(fn: Node): FunctionMetrics {
  let decisions = 0;
  let maxDepth = 0;
  walkOwn(fn, (node, depth) => {
    const kind = node.getKind();
    if (DECISION_KINDS.has(kind)) decisions++;
    else if (Node.isBinaryExpression(node) &&
        LOGICAL_OPERATORS.has(node.getOperatorToken().getKind())) decisions++;
    if (STATEMENT_KINDS.has(kind) && depth > maxDepth) maxDepth = depth;
  });
  const startLine = fn.getStartLineNumber();
  const endLine = fn.getEndLineNumber();
  return {
    name: functionName(fn),
    kind: fn.getKindName(),
    startLine,
    endLine,
    cyclomaticComplexity: 1 + decisions,
    maxNestingDepth: maxDepth,
    functionLength: endLine - startLine + 1,
  };
}

/** All functions in the file (including nested ones), in source order. */
export function collectFunctions(sourceFile: SourceFile): Node[] {
  const fns: Node[] = [];
  sourceFile.forEachDescendant((node) => {
    if (isFunctionNode(node)) fns.push(node);
  });
  return fns;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function statementLists(sourceFile: SourceFile): Node[][] {
  const lists: Node[][] = [sourceFile.getStatements()];
  sourceFile.forEachDescendant((node) => {
    if (Node.isBlock(node) || Node.isModuleBlock(node) ||
        Node.isCaseClause(node) || Node.isDefaultClause(node)) {
      lists.push(node.getStatements());
    }
  });
  return lists;
}

/**
 * Requirement 13.7. Every window of >= 3 consecutive statements in one
 * statement list is keyed by its whitespace-normalized source text. Starting
 * statements are scanned in source order; at each one, the longest window that
 * equals an earlier, non-overlapping window is counted as a repeat, and the
 * statements it covers (including anything nested in them) are skipped.
 */
export function computeDuplicatedCode(sourceFile: SourceFile): number {
  const text = sourceFile.getFullText();
  const lists = statementLists(sourceFile).filter((l) => l.length >= 3);
  /** Smallest end offset among occurrences of each normalized window. */
  const minEnd = new Map<string, number>();
  const keyOf = (list: Node[], i: number, len: number): string =>
    normalize(text.slice(list[i]!.getStart(), list[i + len - 1]!.getEnd()));

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      for (let len = 3; i + len <= list.length; len++) {
        const key = keyOf(list, i, len);
        const end = list[i + len - 1]!.getEnd();
        const prev = minEnd.get(key);
        if (prev === undefined || end < prev) minEnd.set(key, end);
      }
    }
  }

  const starts: { list: Node[]; index: number; start: number }[] = [];
  for (const list of lists) {
    list.forEach((stmt, index) => starts.push({ list, index, start: stmt.getStart() }));
  }
  starts.sort((a, b) => a.start - b.start);

  const covered: [number, number][] = [];
  const isCovered = (pos: number): boolean => covered.some(([lo, hi]) => pos >= lo && pos < hi);

  let duplicated = 0;
  for (const { list, index, start } of starts) {
    if (isCovered(start)) continue;
    for (let len = list.length - index; len >= 3; len--) {
      const prevEnd = minEnd.get(keyOf(list, index, len));
      if (prevEnd !== undefined && prevEnd <= start) {
        duplicated += len;
        covered.push([start, list[index + len - 1]!.getEnd()]);
        break;
      }
    }
  }
  return duplicated;
}

export function computeMetricsForSourceFile(sourceFile: SourceFile): MetricsReport {
  const functions = collectFunctions(sourceFile).map(measureFunction);
  const sum = (pick: (f: FunctionMetrics) => number): number =>
    functions.reduce((acc, f) => acc + pick(f), 0);
  return {
    functions,
    metrics: {
      cyclomaticComplexity: sum((f) => f.cyclomaticComplexity),
      maxNestingDepth: sum((f) => f.maxNestingDepth),
      functionLength: sum((f) => f.functionLength),
      duplicatedCode: computeDuplicatedCode(sourceFile),
      unusedCode: findUnusedDeclarations(sourceFile).length,
    },
  };
}

/** Computes Metrics for a Position without mutating it. */
export function computeMetrics(position: Position): MetricsReport {
  return computeMetricsForSourceFile(AstEditor.load(position).getSourceFile());
}
