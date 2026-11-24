import { ts } from "ts-morph";
import { safeApply } from "../ast-editor.js";
import type { EditableUnit } from "../ast-editor.js";
import { AstEditor } from "../ast-editor.js";
import type { ApplyResult, Candidate, Position } from "../types.js";

/** Base name for extracted functions (Requirement 8.4). */
export const EXTRACT_BASE_NAME = "extractedBlock";
/** Minimum number of directly contained statements (Requirement 8.1). */
export const MIN_STATEMENTS = 5;

/**
 * Lowest-suffix name selection: `base` if free, otherwise `base2`, `base3`, ...
 * (Requirement 8.4).
 */
export function selectFunctionName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface Plan {
  /** Offsets of the replaced range in the source text. */
  start: number;
  end: number;
  /** Offset at which the new function is inserted. */
  insertAt: number;
  functionName: string;
  parameters: string[];
  functionText: string;
  callText: string;
  description: string;
}

type Analysis = { plan: Plan } | { reason: string };

function isFunctionLikeNode(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

function isLoop(n: ts.Node): boolean {
  return (
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isWhileStatement(n) ||
    ts.isDoStatement(n)
  );
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let p = node.parent; p; p = p.parent) if (isFunctionLikeNode(p)) return p;
  return undefined;
}

function isAsync(fn: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
}

function isReferenceIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  )
    return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (
    (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) &&
    p.label === id
  )
    return false;
  if (ts.isTypePredicateNode(p) && p.parameterName === id) return false;
  return true;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** "pure": plain overwrite. "rw": reads and writes. "none": read only. */
function writeKind(id: ts.Identifier): "pure" | "rw" | "none" {
  let cur: ts.Node = id;
  let climbed = false;
  for (;;) {
    const p: ts.Node | undefined = cur.parent;
    if (!p) return "none";
    if (ts.isParenthesizedExpression(p)) {
      cur = p;
    } else if (
      ts.isArrayLiteralExpression(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === cur)
    ) {
      cur = p;
      climbed = true;
    } else break;
  }
  const p = cur.parent;
  if (!p) return "none";
  if (!climbed) {
    if (
      (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return "rw";
  }
  if (ts.isBinaryExpression(p) && p.left === cur && isAssignmentOperator(p.operatorToken.kind)) {
    if (p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return "pure";
    return climbed ? "none" : "rw";
  }
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur) return "pure";
  return "none";
}

function inTypeNode(id: ts.Node): boolean {
  for (let p = id.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p)) return false;
  }
  return false;
}

const LOCAL_SCOPE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
  ts.SyntaxKind.ModuleBlock,
  ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

function isLocalDeclaration(decl: ts.Node): boolean {
  for (let p = decl.parent; p; p = p.parent) {
    if (isFunctionLikeNode(p) || LOCAL_SCOPE_KINDS.has(p.kind)) return true;
  }
  return false;
}

function isPassableDeclaration(decl: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(decl) ||
    ts.isParameter(decl) ||
    ts.isBindingElement(decl) ||
    ts.isFunctionDeclaration(decl)
  );
}

function walk(node: ts.Node, visit: (n: ts.Node) => boolean | void): void {
  if (visit(node) === false) return;
  ts.forEachChild(node, (c) => walk(c, visit));
}

interface OuterVar {
  symbol: ts.Symbol;
  name: string;
  decl: ts.Node;
  firstPos: number;
  /** Position of the first read (including `+=`, `++`), or Infinity if never read. */
  firstRead: number;
  /** Position of the first write, or Infinity if never written. */
  firstWrite: number;
  read: boolean;
  written: boolean;
  /** Written and never read. */
  firstPureWrite: boolean;
}

function analyzeWindow(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  block: ts.Block,
  startIdx: number,
  endIdx: number,
): Analysis {
  const stmts = block.statements.slice(startIdx, endIdx);
  if (stmts.length < MIN_STATEMENTS) return { reason: "fewer than 5 statements" };
  const fn = enclosingFunction(block);
  if (!fn) return { reason: "block is not inside a function" };
  const enclosingAsync = isAsync(fn);
  const first = stmts[0];
  const last = stmts[stmts.length - 1];
  const ws = first.getStart(sf);
  const we = last.getEnd();

  // --- Control-flow checks (Requirement 8.5) ---
  let failure: string | undefined;
  let hasAwait = false;
  const scan = (
    node: ts.Node,
    st: { fnDepth: number; nonArrow: number; loops: number; switches: number; labels: string[] },
  ): void => {
    if (failure) return;
    let next = st;
    if (isFunctionLikeNode(node)) {
      next = {
        ...st,
        fnDepth: st.fnDepth + 1,
        nonArrow: st.nonArrow + (ts.isArrowFunction(node) ? 0 : 1),
      };
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      next = { ...st, nonArrow: st.nonArrow + 1 };
    } else if (isLoop(node)) {
      next = { ...st, loops: st.loops + 1 };
    } else if (ts.isSwitchStatement(node)) {
      next = { ...st, switches: st.switches + 1 };
    } else if (ts.isLabeledStatement(node)) {
      next = { ...st, labels: [...st.labels, node.label.text] };
    }

    if (st.fnDepth === 0) {
      if (ts.isReturnStatement(node) && node !== last) {
        failure = "return that is not the final statement";
        return;
      }
      if (ts.isBreakStatement(node)) {
        const ok = node.label
          ? st.labels.includes(node.label.text)
          : st.loops + st.switches > 0;
        if (!ok) failure = "break targeting outside the block";
      }
      if (ts.isContinueStatement(node)) {
        const ok = node.label ? st.labels.includes(node.label.text) : st.loops > 0;
        if (!ok) failure = "continue targeting outside the block";
      }
      if (
        ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
      ) {
        hasAwait = true;
        if (!enclosingAsync) failure = "await in a non-async function";
      }
      if (ts.isYieldExpression(node)) failure = "yield expression";
    }
    if (st.nonArrow === 0) {
      if (
        node.kind === ts.SyntaxKind.ThisKeyword ||
        node.kind === ts.SyntaxKind.SuperKeyword ||
        ts.isMetaProperty(node) ||
        (ts.isIdentifier(node) && node.text === "arguments" && isReferenceIdentifier(node))
      ) {
        failure = "uses this, super, arguments or new.target";
      }
    }
    if (failure) return;
    ts.forEachChild(node, (c) => scan(c, next));
  };
  const initial = { fnDepth: 0, nonArrow: 0, loops: 0, switches: 0, labels: [] as string[] };
  for (const s of stmts) scan(s, initial);
  if (failure) return { reason: failure };

  // --- Identifier resolution (Requirement 8.1) ---
  const getSym = (id: ts.Identifier): ts.Symbol | undefined => {
    const p = id.parent;
    if (p && ts.isShorthandPropertyAssignment(p) && p.name === id) {
      return checker.getShorthandAssignmentValueSymbol(p);
    }
    return checker.getSymbolAtLocation(id);
  };
  const inWindow = (n: ts.Node): boolean =>
    n.getSourceFile() === sf && n.getStart(sf) >= ws && n.getEnd() <= we;

  const outer = new Map<ts.Symbol, OuterVar>();
  const internalNames = new Set<string>();
  const windowIdentifiers = new Set<string>();
  let order = 0;
  walk(block, (n) => {
    if (failure) return false;
    if (n.end <= ws || n.pos >= we) return n === block ? true : false;
    if (!ts.isIdentifier(n)) return true;
    windowIdentifiers.add(n.text);
    if (n.getStart(sf) < ws || n.getEnd() > we) return true;
    if (!isReferenceIdentifier(n)) return true;
    const sym = getSym(n);
    if (!sym) {
      failure = `unresolved identifier '${n.text}'`;
      return false;
    }
    const decls = sym.declarations ?? [];
    if (decls.length === 0) return true; // intrinsic such as `undefined`
    if (decls.some((d) => inWindow(d))) {
      internalNames.add(n.text);
      return true;
    }
    if (decls[0].getSourceFile() !== sf) return true; // global / lib
    const decl = decls[0];
    if (!isLocalDeclaration(decl)) return true; // module level, reachable from the new function
    if (!isPassableDeclaration(decl) || inTypeNode(n)) {
      failure = `identifier '${n.text}' cannot be passed as an argument`;
      return false;
    }
    const pos = order++;
    let entry = outer.get(sym);
    if (!entry) {
      entry = {
        symbol: sym,
        name: n.text,
        decl,
        firstPos: pos,
        firstRead: Infinity,
        firstWrite: Infinity,
        read: false,
        written: false,
        firstPureWrite: false,
      };
      outer.set(sym, entry);
    }
    const wk = writeKind(n);
    if (wk === "none" || wk === "rw") {
      entry.read = true;
      if (pos < entry.firstRead) entry.firstRead = pos;
    }
    if (wk === "pure" || wk === "rw") {
      entry.written = true;
      if (pos < entry.firstWrite) entry.firstWrite = pos;
    }
    return true;
  });
  if (failure) return { reason: failure };

  // Declarations made in the block must not be used after it.
  if (internalNames.size > 0) {
    walk(sf, (n) => {
      if (failure) return false;
      if (!ts.isIdentifier(n) || !internalNames.has(n.text)) return true;
      if (n.getStart(sf) >= ws && n.getEnd() <= we) return true;
      if (!isReferenceIdentifier(n)) return true;
      const sym = getSym(n);
      if (sym?.declarations?.some((d) => inWindow(d))) {
        failure = `'${n.text}' is declared in the block and used after it`;
        return false;
      }
      return true;
    });
    if (failure) return { reason: failure };
  }

  // --- Plan ---
  const vars = [...outer.values()].sort((a, b) => a.firstPos - b.firstPos);
  const topStmt = (() => {
    let n: ts.Node = block;
    while (n.parent && !ts.isSourceFile(n.parent)) n = n.parent;
    return n;
  })();

  // A variable that is only overwritten, unconditionally by a top-level statement, needs no parameter.
  const unconditionalOverwrite = (v: OuterVar): boolean =>
    stmts.some(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(s.expression.left) &&
        getSym(s.expression.left) === v.symbol,
    );
  for (const v of vars) v.firstPureWrite = v.written && !v.read && unconditionalOverwrite(v);
  // Parameter order (Requirement 8.2): read variables by first read, then
  // write-only (conditionally written) variables by first write.
  const params = [
    ...vars.filter((v) => v.read).sort((a, b) => a.firstRead - b.firstRead),
    ...vars
      .filter((v) => !v.read && v.written && !v.firstPureWrite)
      .sort((a, b) => a.firstWrite - b.firstWrite),
  ];
  const assigned = vars.filter((v) => v.written);
  const localOnly = vars.filter((v) => v.firstPureWrite);

  const taken = new Set<string>();
  for (const s of checker.getSymbolsInScope(
    block,
    ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias,
  )) {
    taken.add(s.name);
  }
  walk(topStmt, (n) => {
    if (ts.isIdentifier(n)) taken.add(n.text);
  });
  for (const t of windowIdentifiers) taken.add(t);
  for (const v of vars) taken.add(v.name);
  const functionName = selectFunctionName(EXTRACT_BASE_NAME, taken);
  taken.add(functionName);

  const typeParams = new Set<string>();
  for (let p: ts.Node | undefined = block; p; p = p.parent) {
    const tps = (p as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> })
      .typeParameters;
    if (tps) for (const tp of tps) typeParams.add(tp.name.text);
  }
  const typeText = (v: OuterVar): string => {
    try {
      const t = checker.getTypeOfSymbolAtLocation(v.symbol, v.decl);
      const text = checker.typeToString(
        t,
        block,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
      if (text.includes("import(")) return "any";
      for (const tp of typeParams) if (new RegExp(`\\b${tp}\\b`).test(text)) return "any";
      return text;
    } catch {
      return "any";
    }
  };

  const src = sf.text;
  const lineStart = src.lastIndexOf("\n", ws - 1) + 1;
  const prefix = src.slice(lineStart, ws);
  const indent = /^\s*$/.test(prefix) ? prefix : "";

  const finalReturn = ts.isReturnStatement(last) ? last : undefined;
  const valueExpr = finalReturn?.expression?.getText(sf);
  const bodyEnd = finalReturn ? stmts[stmts.length - 2].getEnd() : we;
  const bodyText = src.slice(ws, bodyEnd);

  const asyncKw = hasAwait ? "async " : "";
  const call = `${hasAwait ? "await " : ""}${functionName}(${params.map((p) => p.name).join(", ")})`;

  const bodyLines: string[] = [];
  for (const v of localOnly) bodyLines.push(`let ${v.name}: ${typeText(v)};`);
  bodyLines.push(bodyText);

  const callLines: string[] = [];
  const names = assigned.map((a) => a.name);
  if (assigned.length === 0) {
    if (valueExpr !== undefined) {
      bodyLines.push(`return ${valueExpr};`);
      callLines.push(`return ${call};`);
    } else {
      callLines.push(`${call};`);
      if (finalReturn) callLines.push("return;");
    }
  } else if (valueExpr === undefined && assigned.length === 1) {
    bodyLines.push(`return ${names[0]};`);
    callLines.push(`${names[0]} = ${call};`);
    if (finalReturn) callLines.push("return;");
  } else {
    const reserved = new Set([...taken, ...names]);
    const tmp = selectFunctionName("extractedResult", reserved);
    reserved.add(tmp);
    const members = [...names];
    let valueKey: string | undefined;
    if (valueExpr !== undefined) {
      valueKey = selectFunctionName("value", reserved);
      members.unshift(`${valueKey}: ${valueExpr}`);
    }
    bodyLines.push(`return { ${members.join(", ")} };`);
    callLines.push(`const ${tmp} = ${call};`);
    for (const n of names) callLines.push(`${n} = ${tmp}.${n};`);
    if (valueKey !== undefined) callLines.push(`return ${tmp}.${valueKey};`);
    else if (finalReturn) callLines.push("return;");
  }

  const paramText = params.map((p) => `${p.name}: ${typeText(p)}`).join(", ");
  const functionText =
    `${asyncKw}function ${functionName}(${paramText}) {\n` +
    bodyLines.map((l) => `  ${l}`).join("\n") +
    "\n}";
  const callText = callLines.join(`\n${indent}`);

  const fnName =
    (fn as unknown as { name?: ts.Node }).name &&
    ts.isIdentifier((fn as unknown as { name: ts.Node }).name)
      ? (fn as unknown as { name: ts.Identifier }).name.text
      : "<anonymous>";
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  return {
    plan: {
      start: ws,
      end: we,
      insertAt: topStmt.getEnd(),
      functionName,
      parameters: params.map((p) => p.name),
      functionText,
      callText,
      description: `Extract lines ${lineOf(ws)}-${lineOf(we)} of ${fnName}() into ${functionName}()`,
    },
  };
}

function findBlock(sf: ts.SourceFile, blockStart: number, startIdx: number): ts.Block | undefined {
  let found: ts.Block | undefined;
  walk(sf, (n) => {
    if (found) return false;
    if (ts.isBlock(n) && n.getStart(sf) === blockStart && n.statements.length > startIdx) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

interface Site {
  blockStart: number;
  startIdx: number;
  endIdx: number;
  windowStart: number;
  windowEnd: number;
}

function analyzeSite(unit: EditableUnit, site: Site): Analysis {
  const sf = unit.getSourceFile().compilerNode;
  const checker = unit.getTypeChecker().compilerObject;
  const block = findBlock(sf, site.blockStart, site.startIdx);
  if (!block || block.statements.length < site.endIdx) {
    return { reason: "extraction site no longer exists" };
  }
  const res = analyzeWindow(sf, checker, block, site.startIdx, site.endIdx);
  if ("plan" in res && (res.plan.start !== site.windowStart || res.plan.end !== site.windowEnd)) {
    return { reason: "extraction site moved" };
  }
  return res;
}

function applyPlan(source: string, plan: Plan): string {
  return (
    source.slice(0, plan.start) +
    plan.callText +
    source.slice(plan.end, plan.insertAt) +
    "\n\n" +
    plan.functionText +
    source.slice(plan.insertAt)
  );
}

function makeCandidate(site: Site, plan: Plan): Candidate {
  return {
    move: "ExtractFunction",
    displayName: "Extract function",
    describe: () => plan.description,
    apply(position: Position): ApplyResult {
      const result = safeApply(position, (unit) => {
        const res = analyzeSite(unit, site);
        if (!("plan" in res)) throw new Error(res.reason);
        unit.getSourceFile().replaceWithText(applyPlan(unit.getSourceFile().getFullText(), res.plan));
      });
      if (!result.ok) {
        return { ok: false, error: { reason: `Extraction failed: ${result.error?.reason ?? "unknown"}` } };
      }
      return result;
    },
  };
}

/**
 * Generates Extract_Function candidates in source order. For each block with at
 * least 5 statements, the longest eligible contiguous window (earliest on ties)
 * yields one candidate.
 */
export function generateExtractFunctionCandidates(position: Position): Candidate[] {
  const unit = AstEditor.load(position);
  const sf = unit.getSourceFile().compilerNode;
  const checker = unit.getTypeChecker().compilerObject;
  const candidates: Candidate[] = [];
  walk(sf, (n) => {
    if (!ts.isBlock(n) || n.statements.length < MIN_STATEMENTS || !enclosingFunction(n)) return true;
    const count = n.statements.length;
    for (let len = count; len >= MIN_STATEMENTS; len--) {
      let hit = false;
      for (let start = 0; start + len <= count; start++) {
        const res = analyzeWindow(sf, checker, n, start, start + len);
        if ("plan" in res) {
          candidates.push(
            makeCandidate(
              {
                blockStart: n.getStart(sf),
                startIdx: start,
                endIdx: start + len,
                windowStart: res.plan.start,
                windowEnd: res.plan.end,
              },
              res.plan,
            ),
          );
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    return true;
  });
  return candidates;
}

export const ExtractFunctionGenerator = {
  generate(position: Position): Candidate[] {
    return generateExtractFunctionCandidates(position);
  },
};
