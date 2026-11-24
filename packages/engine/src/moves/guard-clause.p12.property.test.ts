// Feature: refactor-fish, Property 12: For any function/method/arrow function body generated with a controlled trailing-statement shape after a candidate `if` (nothing, a single `return`, or some other statement) and a controlled set of identifiers already declared in the enclosing scope, the Move_Generator SHALL generate a Guard_Clause candidate for an eligible `if`-without-`else` if and only if it is followed by nothing or by exactly one `return` statement (and, when followed by nothing, the function's return type is void or includes undefined), and unwrapping its body would introduce no `let`/`const`/`class`/function name collision with the enclosing scope.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateGuardClauseCandidates } from "./guard-clause.js";

/**
 * Each generated Position contains exactly one function holding exactly one
 * `if` statement directly in its body, so the expected candidate count is 0 or 1.
 * Generators are out of scope (the generator skips them), so none are produced.
 */

type FnKind = "declaration" | "expression" | "arrow" | "method";
type ReturnKind = "void" | "includesUndefined" | "excludesUndefined";
type Trailing = "nothing" | "return" | "other";
/** Where a name is already declared in the enclosing function scope. */
type ScopeSlot = "none" | "param" | "let" | "const" | "var" | "hoistedVar" | "function" | "class";
/** How the `if` body declares a name. `var` is not a collision source per Requirement 6.6. */
type IfDeclKind = "let" | "const" | "class" | "function" | "var";

const NAMES = ["a", "b", "c"] as const;

interface Shape {
  fnKind: FnKind;
  isAsync: boolean;
  returnKind: ReturnKind;
  hasElse: boolean;
  trailing: Trailing;
  scope: ScopeSlot[]; // indexed like NAMES
  ifDecls: { name: (typeof NAMES)[number]; kind: IfDeclKind }[];
}

const arbShape: fc.Arbitrary<Shape> = fc.record({
  fnKind: fc.constantFrom<FnKind>("declaration", "expression", "arrow", "method"),
  isAsync: fc.boolean(),
  returnKind: fc.constantFrom<ReturnKind>("void", "includesUndefined", "excludesUndefined"),
  hasElse: fc.boolean(),
  trailing: fc.constantFrom<Trailing>("nothing", "return", "other"),
  scope: fc.array(
    fc.constantFrom<ScopeSlot>("none", "param", "let", "const", "var", "hoistedVar", "function", "class"),
    { minLength: NAMES.length, maxLength: NAMES.length },
  ),
  ifDecls: fc.uniqueArray(
    fc.record({
      name: fc.constantFrom(...NAMES),
      kind: fc.constantFrom<IfDeclKind>("let", "const", "class", "function", "var"),
    }),
    { maxLength: 3, selector: (d) => d.name },
  ),
});

function render(s: Shape): string {
  const inner = { void: "void", includesUndefined: "number | undefined", excludesUndefined: "number" }[s.returnKind];
  const retType = s.isAsync ? `Promise<${inner}>` : inner;
  const params = ["flag: boolean"];
  const pre: string[] = [];
  s.scope.forEach((slot, i) => {
    const n = NAMES[i]!;
    switch (slot) {
      case "param": params.push(`${n}: number`); break;
      case "let": pre.push(`let ${n} = ${i};`); break;
      case "const": pre.push(`const ${n} = ${i};`); break;
      case "var": pre.push(`var ${n} = ${i};`); break;
      case "hoistedVar": pre.push(`{ var ${n} = ${i}; }`); break;
      case "function": pre.push(`function ${n}() {}`); break;
      case "class": pre.push(`class ${n} {}`); break;
      case "none": break;
    }
  });
  const ifBody = s.ifDecls.map(({ name, kind }) => {
    if (kind === "class") return `class ${name} {}`;
    if (kind === "function") return `function ${name}() {}`;
    return `${kind} ${name} = 1;`;
  });
  ifBody.push("console.log(flag);");
  const lines = [...pre, `if (flag) {`, ...ifBody.map((l) => `  ${l}`), `}${s.hasElse ? " else { console.log(0); }" : ""}`];
  if (s.trailing === "return") lines.push(s.returnKind === "void" ? "return;" : "return 0;");
  if (s.trailing === "other") lines.push("console.log(2);");
  const body = lines.map((l) => `  ${l}`).join("\n");
  const asyncKw = s.isAsync ? "async " : "";
  const sig = `(${params.join(", ")}): ${retType}`;
  switch (s.fnKind) {
    case "declaration":
      return `export ${asyncKw}function target${sig} {\n${body}\n}\n`;
    case "expression":
      return `export const target = ${asyncKw}function ${sig} {\n${body}\n};\n`;
    case "arrow":
      return `export const target = ${asyncKw}${sig} => {\n${body}\n};\n`;
    case "method":
      return `export class Holder {\n  ${asyncKw}target${sig} {\n${body}\n  }\n}\n`;
  }
}

function expectedEligible(s: Shape): boolean {
  if (s.hasElse) return false;
  if (s.trailing === "other") return false;
  if (s.trailing === "nothing" && s.returnKind === "excludesUndefined") return false;
  const collides = s.ifDecls.some(
    ({ name, kind }) => kind !== "var" && s.scope[NAMES.indexOf(name)] !== "none",
  );
  return !collides;
}

describe("Property 12: Guard_Clause eligibility predicate", () => {
  /** **Validates: Requirements 6.1, 6.5, 6.6** */
  it("generates a candidate iff the if is eligible", () => {
    fc.assert(
      fc.property(arbShape, (shape) => {
        const sourceText = render(shape);
        const candidates = generateGuardClauseCandidates({ sourceText, filePath: "target.ts" });
        expect(candidates.length, sourceText).toBe(expectedEligible(shape) ? 1 : 0);
        for (const c of candidates) {
          expect(c.move).toBe("GuardClause");
          expect(c.describe()).toBe("Convert if (flag) in target() to a guard clause");
        }
      }),
      { numRuns: 100 },
    );
  }, 300_000); // each run loads a fresh in-memory ts-morph Project
});
