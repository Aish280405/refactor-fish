// Feature: refactor-fish, Property 14: For any Position containing one or more independently generated rewrite sites of the forms `x === true`, `!!x` in a boolean context, and `if (c) return true; else return false;`, each with an independently controlled static type (exactly `boolean`, a union containing a non-boolean member, `any`, or `unknown`), the Move_Generator SHALL generate a Simplify_Boolean candidate for a site if and only if the relevant operand's static type is exactly `boolean`, and applying any single candidate SHALL change only its own site's source text, leaving every other site and the rest of the file unchanged.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateSimplifyBoolean } from "./simplify-boolean.js";
import type { Position } from "../types.js";

/**
 * Note: design.md Property 14 says every site needs an exactly-`boolean` operand.
 * Requirement 7.2 is looser for `!!x`, and Requirement 7.4 applies the type check
 * only to criteria 1 (`x === true`) and 3 (`if (c) return true; else return false;`).
 * This test follows the requirements:
 * - `x === true` and the if/return form: candidate iff the operand type is exactly `boolean`;
 * - `!!x` directly as an if/while/ternary condition: candidate for any type of `x`;
 * - `!!x` as an `&&`/`||` operand: candidate iff the containing expression is such a
 *   condition, or `x` is exactly `boolean`.
 */

interface TypeCase {
  text: string;
  exactBoolean: boolean;
}

const TYPES: TypeCase[] = [
  { text: "boolean", exactBoolean: true },
  { text: "B", exactBoolean: true }, // `type B = boolean;` alias
  { text: "true | false", exactBoolean: true }, // the same type as `boolean`
  { text: "boolean | undefined", exactBoolean: false },
  { text: "boolean | number", exactBoolean: false },
  { text: "any", exactBoolean: false },
  { text: "unknown", exactBoolean: false },
  { text: "number", exactBoolean: false },
];

type SiteForm =
  | "eqTrue"
  | "ifReturnBare"
  | "ifReturnBraced"
  | "notNotIf"
  | "notNotWhile"
  | "notNotTernary"
  | "notNotAndCond"
  | "notNotOrCondRight"
  | "notNotAndValue"
  | "notNotOrValueRight";

const FORMS: SiteForm[] = [
  "eqTrue",
  "ifReturnBare",
  "ifReturnBraced",
  "notNotIf",
  "notNotWhile",
  "notNotTernary",
  "notNotAndCond",
  "notNotOrCondRight",
  "notNotAndValue",
  "notNotOrValueRight",
];

interface SiteSpec {
  form: SiteForm;
  type: TypeCase;
}

interface BuiltSite {
  before: string;
  site: string;
  replacement: string;
  after: string;
  expectCandidate: boolean;
}

function buildSite(spec: SiteSpec, i: number): BuiltSite {
  const t = spec.type.text;
  const head = `export function f${i}(x: ${t}, y: boolean) { `;
  const exact = spec.type.exactBoolean;
  switch (spec.form) {
    case "eqTrue":
      return { before: `${head}return `, site: "x === true", replacement: "x", after: "; }", expectCandidate: exact };
    case "ifReturnBare":
      return {
        before: head,
        site: "if (x) return true; else return false;",
        replacement: "return x;",
        after: " }",
        expectCandidate: exact,
      };
    case "ifReturnBraced":
      return {
        before: head,
        site: "if (x) { return true; } else { return false; }",
        replacement: "return x;",
        after: " }",
        expectCandidate: exact,
      };
    case "notNotIf":
      return { before: `${head}if (`, site: "!!x", replacement: "x", after: ") { g(); } }", expectCandidate: true };
    case "notNotWhile":
      return { before: `${head}while (`, site: "!!x", replacement: "x", after: ") { break; } }", expectCandidate: true };
    case "notNotTernary":
      return { before: `${head}return `, site: "!!x", replacement: "x", after: " ? 1 : 2; }", expectCandidate: true };
    case "notNotAndCond":
      return { before: `${head}if (`, site: "!!x", replacement: "x", after: " && y) { g(); } }", expectCandidate: true };
    case "notNotOrCondRight":
      return { before: `${head}while (y || `, site: "!!x", replacement: "x", after: ") { break; } }", expectCandidate: true };
    case "notNotAndValue":
      return {
        before: `${head}const z = `,
        site: "!!x",
        replacement: "x",
        after: " && y; return z; }",
        expectCandidate: exact,
      };
    case "notNotOrValueRight":
      return {
        before: `${head}const z = y || `,
        site: "!!x",
        replacement: "x",
        after: "; return z; }",
        expectCandidate: exact,
      };
  }
}

const HEADER = "type B = boolean;\ndeclare function g(): void;\n";

function render(sites: BuiltSite[], rewriteIndex: number): string {
  const lines = sites.map(
    (s, i) => `${s.before}${i === rewriteIndex ? s.replacement : s.site}${s.after}`,
  );
  return `${HEADER}${lines.join("\n")}\n`;
}

const arbSiteSpec: fc.Arbitrary<SiteSpec> = fc.record({
  form: fc.constantFrom(...FORMS),
  type: fc.constantFrom(...TYPES),
});

describe("Property 14: Simplify_Boolean rewrite-iff-exact-boolean-type with site locality", () => {
  /** **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5** */
  it("generates one candidate per eligible site, and each rewrites only its own site", () => {
    fc.assert(
      fc.property(fc.array(arbSiteSpec, { minLength: 1, maxLength: 5 }), (specs) => {
        const sites = specs.map(buildSite);
        const source = render(sites, -1);
        const position: Position = { sourceText: source, filePath: "target.ts" };

        const eligible = sites.map((s, i) => (s.expectCandidate ? i : -1)).filter((i) => i >= 0);
        const candidates = generateSimplifyBoolean(position);
        expect(
          candidates.length,
          `expected candidates at sites ${JSON.stringify(eligible)} for:\n${source}\ngot: ${candidates
            .map((c) => c.describe())
            .join(" | ")}`,
        ).toBe(eligible.length);

        // Candidates are in source order, one per site; each changes only its own site.
        candidates.forEach((c, k) => {
          expect(c.move).toBe("SimplifyBoolean");
          const result = c.apply(position);
          expect(result.ok, result.error ?? "").toBe(true);
          expect(result.resultingSource).toBe(render(sites, eligible[k]!));
        });

        // Generation and application never mutate the input Position.
        expect(position.sourceText).toBe(source);
      }),
      { numRuns: 100 },
    );
  }, 300_000); // each run loads a fresh ts-morph Project
});
