// Feature: refactor-fish, Property 15: For any function body generated with a contiguous statement sequence of controlled length and a controlled mix of free identifiers (resolvable to the enclosing scope or declared inside the sequence), early returns, break/continue targets, and `await` usage inside an async or non-async enclosing function, the Move_Generator SHALL generate an Extract_Function candidate for the sequence if and only if it has at least 5 statements directly in the block, every free identifier it references resolves to either an enclosing-scope variable or a declaration inside the sequence, it contains no `return` other than as its final statement, no `break`/`continue` targets a loop or label outside the sequence, and it contains no `await` that would require the extracted function to be async when the enclosing function is not async.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateExtractFunctionCandidates } from "./extract-function.js";

/**
 * The candidate sequence is the whole body of a labeled `for` loop inside `f`,
 * one statement per line. The loop gives `break`/`continue` an outside target,
 * and `i` / `p` are enclosing-scope variables. The function body itself holds a
 * single statement, and nested blocks hold fewer than 5, so the only block that
 * can yield a candidate is the sequence. A candidate "for the sequence" is one
 * whose description covers exactly its first and last line.
 *
 * **Validates: Requirements 8.1, 8.5**
 */

type Kind =
  | "useOuter" // references p, i and a declared global: resolvable
  | "declLocal" // declares a local inside the sequence
  | "useLocal" // references the most recent local declared earlier in the sequence
  | "unresolved" // references an undeclared identifier
  | "earlyReturn" // `if (...) return ...;` (a return that is not the final statement)
  | "breakOuter" // break targeting the loop outside the sequence
  | "continueOuter"
  | "breakOuterLabel"
  | "continueOuterLabel"
  | "innerLoopBreak" // break/continue whose target loop is inside the sequence
  | "innerLabelContinue"
  | "innerSwitchBreak"
  | "await";

const KINDS: Kind[] = [
  "useOuter",
  "declLocal",
  "useLocal",
  "unresolved",
  "earlyReturn",
  "breakOuter",
  "continueOuter",
  "breakOuterLabel",
  "continueOuterLabel",
  "innerLoopBreak",
  "innerLabelContinue",
  "innerSwitchBreak",
  "await",
];

interface Shape {
  isAsync: boolean;
  kinds: Kind[];
  finalReturn: boolean;
}

// Bias toward clean statements so eligible sequences are common.
const arbKind: fc.Arbitrary<Kind> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<Kind>("useOuter", "declLocal", "useLocal") },
  { weight: 2, arbitrary: fc.constantFrom<Kind>("innerLoopBreak", "innerLabelContinue", "innerSwitchBreak") },
  { weight: 3, arbitrary: fc.constantFrom<Kind>(...KINDS) },
);

const arbShape: fc.Arbitrary<Shape> = fc.record({
  isAsync: fc.boolean(),
  kinds: fc.array(arbKind, { minLength: 3, maxLength: 7 }),
  finalReturn: fc.boolean(),
});

interface Rendered {
  source: string;
  firstLine: number;
  lastLine: number;
  expected: boolean;
}

function render(s: Shape): Rendered {
  const stmts: string[] = [];
  let lastLocal: string | undefined;
  let unresolved = false;
  let earlyReturn = false;
  let outsideJump = false;
  let usesAwait = false;
  s.kinds.forEach((k, idx) => {
    switch (k) {
      case "useOuter":
        stmts.push(`sink(p + i + g + ${idx});`);
        break;
      case "declLocal":
        lastLocal = `v${idx}`;
        stmts.push(`const v${idx} = i * ${idx};`);
        break;
      case "useLocal":
        stmts.push(lastLocal ? `sink(${lastLocal} + ${idx});` : `sink(${idx});`);
        break;
      case "unresolved":
        unresolved = true;
        stmts.push(`sink(missing${idx});`);
        break;
      case "earlyReturn":
        earlyReturn = true;
        stmts.push(`if (p > ${idx}) return ${idx};`);
        break;
      case "breakOuter":
        outsideJump = true;
        stmts.push(`if (p > ${idx}) break;`);
        break;
      case "continueOuter":
        outsideJump = true;
        stmts.push(`if (p > ${idx}) continue;`);
        break;
      case "breakOuterLabel":
        outsideJump = true;
        stmts.push(`if (p > ${idx}) break outer;`);
        break;
      case "continueOuterLabel":
        outsideJump = true;
        stmts.push(`if (p > ${idx}) continue outer;`);
        break;
      case "innerLoopBreak":
        stmts.push(`for (let j = 0; j < 2; j++) { if (j > p) break; sink(j); }`);
        break;
      case "innerLabelContinue":
        stmts.push(`inner${idx}: for (let k = 0; k < 2; k++) { if (k > p) continue inner${idx}; sink(k); }`);
        break;
      case "innerSwitchBreak":
        stmts.push(`switch (p) { case ${idx}: sink(${idx}); break; default: break; }`);
        break;
      case "await":
        usesAwait = true;
        stmts.push(`await wait();`);
        break;
    }
  });
  if (s.finalReturn) stmts.push(`return p + i;`);

  const header = [
    `declare const g: number;`,
    `declare function sink(x: number): void;`,
    `declare function wait(): Promise<void>;`,
    `${s.isAsync ? "async " : ""}function f(p: number) {`,
    `  outer: for (let i = 0; i < 3; i++) {`,
  ];
  const lines = [...header, ...stmts.map((t) => `    ${t}`), `  }`, `  return 0;`, `}`, ``];
  const firstLine = header.length + 1;
  const lastLine = header.length + stmts.length;
  const expected =
    stmts.length >= 5 && !unresolved && !earlyReturn && !outsideJump && !(usesAwait && !s.isAsync);
  return { source: lines.join("\n"), firstLine, lastLine, expected };
}

describe("Property 15: Extract_Function eligibility predicate", () => {
  it(
    "emits a candidate for the sequence iff it meets the eligibility rules",
    () => {
      fc.assert(
        fc.property(arbShape, (shape) => {
          const r = render(shape);
          const cands = generateExtractFunctionCandidates({ sourceText: r.source, filePath: "target.ts" });
          const prefix = `Extract lines ${r.firstLine}-${r.lastLine} of f() into `;
          const covering = cands.filter((c) => c.describe().startsWith(prefix));
          expect(covering.length, r.source).toBe(r.expected ? 1 : 0);
        }),
        { numRuns: 100 },
      );
    },
    300_000,
  );
});
