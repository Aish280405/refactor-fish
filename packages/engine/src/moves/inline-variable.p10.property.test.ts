// Feature: refactor-fish, Property 10: For any `const` declaration with a single identifier binding and an initializer, embedded in a generated Position with a controlled reference count, export status, intervening side-effecting expressions, and reference-site nesting (nested function, loop, or conditionally-evaluated branch), the Move_Generator SHALL generate an Inline_Variable candidate for it if and only if: it has exactly one reference outside the declaration, it is not exported, no side-effecting expression or reassignment of a variable the initializer reads occurs on the execution path between declaration and reference, and if the reference is inside a nested function/loop/conditional branch not containing the declaration then the initializer contains no side-effecting expression.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Position } from "../types.js";
import { generateInlineVariable } from "./inline-variable.js";

/**
 * Scope note: the generator rejects some cases beyond the spec (jumps after a
 * side-effecting initializer, loop writes to variables the initializer reads,
 * `this`/`arguments` in nested non-arrow functions, shadowing, JSX/typeof/write
 * reference positions). Generated Positions avoid all of those: there are no
 * jump statements, the initializer never uses `this`/`arguments`, no name is
 * redeclared at the reference site, the reference is always a plain call
 * argument, and loops are `while (flag)` so no loop header writes anything.
 */

type ExportKind = "none" | "modifier" | "specifier" | "default";
type Nest =
  | "plain"
  | "function"
  | "arrow"
  | "while"
  | "forOf"
  | "ifThen"
  | "ifElse"
  | "and"
  | "or"
  | "nullish"
  | "ternaryTrue"
  | "ternaryFalse";

interface Init {
  text: string;
  effectful: boolean;
}

const arbInit: fc.Arbitrary<Init> = fc.constantFrom<Init>(
  { text: "a + 1", effectful: false },
  { text: "a * 2", effectful: false },
  { text: "[a, 3]", effectful: false },
  { text: "f(a)", effectful: true },
  { text: "new Box(a)", effectful: true },
);

interface Stmt {
  text: string;
  effectful: boolean;
}

/** Statements placed on the path between the declaration and the reference. */
const arbStmt: fc.Arbitrary<Stmt> = fc.constantFrom<Stmt>(
  { text: "const t = 7;", effectful: false },
  { text: "void 0;", effectful: false },
  { text: "b + 1;", effectful: false },
  { text: "f(1);", effectful: true },
  { text: "a = 2;", effectful: true }, // reassignment of a variable the initializer reads
  { text: "b++;", effectful: true },
  { text: "delete obj.k;", effectful: true },
);

/** Nesting forms whose reference sits in a block where statements can precede it. */
const blockNests = new Set<Nest>(["function", "arrow", "while", "forOf", "ifThen", "ifElse"]);

interface Shape {
  init: Init;
  exportKind: ExportKind;
  refCount: 0 | 1 | 2;
  nest: Nest;
  before: Stmt[];
  inside: Stmt[];
  trailingWrite: boolean;
}

const arbShape: fc.Arbitrary<Shape> = fc.record({
  init: arbInit,
  exportKind: fc.constantFrom<ExportKind>("none", "none", "modifier", "specifier", "default"),
  refCount: fc.constantFrom<0 | 1 | 2>(0, 1, 1, 1, 2),
  nest: fc.constantFrom<Nest>(
    "plain",
    "function",
    "arrow",
    "while",
    "forOf",
    "ifThen",
    "ifElse",
    "and",
    "or",
    "nullish",
    "ternaryTrue",
    "ternaryFalse",
  ),
  before: fc.array(arbStmt, { maxLength: 2 }),
  inside: fc.array(arbStmt, { maxLength: 2 }),
  trailingWrite: fc.boolean(),
});

/** Gives each `const t` a unique name so no declaration collides. */
function render(stmts: Stmt[], counter: { n: number }): string[] {
  return stmts.map((s) => s.text.replace("const t ", `const t${counter.n++} `));
}

function build(shape: Shape): { source: string; inside: Stmt[] } {
  const counter = { n: 0 };
  const inside = blockNests.has(shape.nest) ? shape.inside : [];
  const lines = [
    "declare function f(n: number): number;",
    "declare function sink(v: unknown): void;",
    "declare class Box { constructor(n: number); }",
    "declare const flag: boolean;",
    "declare const maybe: number | undefined;",
    "declare const items: number[];",
    "declare const obj: { k?: number };",
    "let a = 1;",
    "let b = 0;",
    `${shape.exportKind === "modifier" ? "export " : ""}const x = ${shape.init.text};`,
    ...render(shape.before, counter),
  ];

  if (shape.refCount >= 1) {
    const body = [...render(inside, counter), "sink(x);"].join(" ");
    switch (shape.nest) {
      case "plain":
        lines.push("sink(x);");
        break;
      case "function":
        lines.push(`function g() { ${body} }`);
        break;
      case "arrow":
        lines.push(`const g = () => { ${body} };`);
        break;
      case "while":
        lines.push(`while (flag) { ${body} }`);
        break;
      case "forOf":
        lines.push(`for (const item of items) { ${body} }`);
        break;
      case "ifThen":
        lines.push(`if (flag) { ${body} }`);
        break;
      case "ifElse":
        lines.push(`if (flag) { void 0; } else { ${body} }`);
        break;
      case "and":
        lines.push("flag && sink(x);");
        break;
      case "or":
        lines.push("flag || sink(x);");
        break;
      case "nullish":
        lines.push("maybe ?? sink(x);");
        break;
      case "ternaryTrue":
        lines.push("flag ? sink(x) : 0;");
        break;
      case "ternaryFalse":
        lines.push("flag ? 0 : sink(x);");
        break;
    }
  }
  if (shape.refCount === 2) lines.push("sink(x);");
  // A write after the reference is off the path and must not block.
  if (shape.trailingWrite) lines.push("a = 9;");
  if (shape.exportKind === "specifier") lines.push("export { x };");
  if (shape.exportKind === "default") lines.push("export default x;");
  lines.push("");
  return { source: lines.join("\n"), inside };
}

/** The spec predicate (Requirements 5.1, 5.3, 5.4, 5.5). */
function expectedEligible(shape: Shape, inside: Stmt[]): boolean {
  if (shape.refCount !== 1) return false;
  if (shape.exportKind !== "none") return false;
  if ([...shape.before, ...inside].some((s) => s.effectful)) return false;
  if (shape.nest !== "plain" && shape.init.effectful) return false;
  return true;
}

describe("Property 10: Inline_Variable eligibility predicate", () => {
  /** **Validates: Requirements 5.1, 5.3, 5.4, 5.5** */
  it("generates a candidate for `x` exactly when the spec predicate holds", () => {
    fc.assert(
      fc.property(arbShape, (shape) => {
        const { source, inside } = build(shape);
        const position: Position = { sourceText: source, filePath: "target.ts" };
        const forX = generateInlineVariable(position).filter((c) => c.describe() === "Inline variable 'x'");
        expect(forX.length, source).toBe(expectedEligible(shape, inside) ? 1 : 0);
      }),
      { numRuns: 100 },
    );
  }, 300_000); // each run loads a fresh in-memory ts-morph Project
});
