// Feature: refactor-fish, Property 18: For any Position and any eligible Extract_Function candidate, the generated function name SHALL differ from every identifier declared or referenced in the scope chain at the extraction point and from every identifier inside the extracted block, and when the base name collides, the name produced SHALL be the base name with the lowest integer suffix starting at 2 that is not already taken.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsesCleanly } from "../ast-editor.js";
import {
  EXTRACT_BASE_NAME,
  generateExtractFunctionCandidates,
  selectFunctionName,
} from "./extract-function.js";

/**
 * **Validates: Requirements 8.4**
 *
 * Each generated Position has one function `outer` whose body is a single
 * eligible block (no nested 5-statement blocks), so there is exactly one
 * candidate. Every name in NAMES (`extractedBlock`, `extractedBlock2`, ...)
 * may independently be:
 *   - declared at module level (function or const),
 *   - declared in `outer` (parameter or local const),
 *   - referenced inside the block (only when declared, so it resolves),
 *   - used as a property name inside the block,
 *   - used as a property name in `outer`'s return type (inside the enclosing
 *     top-level statement but neither in the scope chain nor in the block),
 *   - used as a property name of a module-level object (outside the enclosing
 *     top-level statement and not in the scope chain).
 *
 * Oracle: `specTaken` is the set the spec requires avoiding (scope chain
 * declarations/references plus identifiers in the block). The implementation
 * also reserves every identifier anywhere in the enclosing top-level statement,
 * which is stricter than the spec, so the expected name is the lowest suffix
 * not in `implTaken = specTaken ∪ {property names in outer's return type}`.
 * Module-level property names are in neither set.
 */

const NAMES = [1, 2, 3, 4, 5].map((i) => (i === 1 ? EXTRACT_BASE_NAME : `${EXTRACT_BASE_NAME}${i}`));

type ModuleDecl = "none" | "function" | "const";
type FnDecl = "none" | "param" | "local";

interface NameUse {
  moduleDecl: ModuleDecl;
  fnDecl: FnDecl;
  blockRef: boolean;
  blockProperty: boolean;
  returnTypeProperty: boolean;
  moduleProperty: boolean;
}

const arbUse: fc.Arbitrary<NameUse> = fc.record({
  moduleDecl: fc.constantFrom<ModuleDecl>("none", "none", "function", "const"),
  fnDecl: fc.constantFrom<FnDecl>("none", "none", "param", "local"),
  blockRef: fc.boolean(),
  blockProperty: fc.boolean(),
  returnTypeProperty: fc.boolean(),
  moduleProperty: fc.boolean(),
});

const arbShape = fc.array(arbUse, { minLength: NAMES.length, maxLength: NAMES.length });

interface Built {
  source: string;
  specTaken: Set<string>;
  implTaken: Set<string>;
}

function build(uses: NameUse[]): Built {
  const specTaken = new Set<string>();
  const implTaken = new Set<string>();
  const moduleLines: string[] = [];
  const params = ["p0: number"];
  const locals: string[] = [];
  const blockLines: string[] = [];
  const returnProps: string[] = [];
  const moduleProps: string[] = [];

  uses.forEach((u, i) => {
    const n = NAMES[i];
    const declared = u.moduleDecl !== "none" || u.fnDecl !== "none";
    if (u.moduleDecl === "function") moduleLines.push(`function ${n}(): number {\n  return ${i + 1};\n}`);
    if (u.moduleDecl === "const") moduleLines.push(`const ${n} = ${i + 1};`);
    if (u.fnDecl === "param") params.push(`${n}: number`);
    if (u.fnDecl === "local") locals.push(`  const ${n} = ${i + 1};`);
    if (declared) specTaken.add(n);
    if (u.blockRef && declared) {
      // Innermost declaration wins; a module function is called.
      const expr = u.fnDecl === "none" && u.moduleDecl === "function" ? `${n}()` : n;
      blockLines.push(`  acc = acc + ${expr};`);
      specTaken.add(n);
    }
    if (u.blockProperty) {
      blockLines.push(`  const o${i} = { ${n}: acc };`, `  acc = acc + o${i}.${n};`);
      specTaken.add(n);
    }
    if (u.returnTypeProperty) {
      returnProps.push(`${n}?: number`);
      implTaken.add(n);
    }
    if (u.moduleProperty) moduleProps.push(`${n}: ${i}`);
  });
  for (const n of specTaken) implTaken.add(n);

  const returnType = returnProps.length > 0 ? `void | { ${returnProps.join("; ")} }` : "void";
  const body = [
    ...locals,
    "  let acc = p0;",
    "  acc = acc + 1;",
    ...blockLines,
    "  acc = acc * 2;",
    "  acc = acc - 1;",
    "  console.log(acc);",
  ];
  const parts = [
    ...moduleLines,
    `export function outer(${params.join(", ")}): ${returnType} {\n${body.join("\n")}\n}`,
  ];
  if (moduleProps.length > 0) parts.push(`export const table = { ${moduleProps.join(", ")} };`);
  return { source: parts.join("\n\n") + "\n", specTaken, implTaken };
}

function lowestFree(taken: Set<string>): string {
  for (const n of NAMES) if (!taken.has(n)) return n;
  return `${EXTRACT_BASE_NAME}${NAMES.length + 1}`;
}

describe("Property 18: Extract_Function name uniqueness", () => {
  it(
    "picks the lowest free suffix avoiding the scope chain and block identifiers",
    () => {
      fc.assert(
        fc.property(arbShape, (uses) => {
          const { source, specTaken, implTaken } = build(uses);
          const position = { sourceText: source, filePath: "target.ts" };
          const cands = generateExtractFunctionCandidates(position);
          expect(cands).toHaveLength(1);

          const match = /into (\w+)\(\)$/.exec(cands[0].describe());
          expect(match).not.toBeNull();
          const name = match![1];

          // (a) differs from everything the spec requires avoiding.
          expect(specTaken.has(name)).toBe(false);
          // (b) base name or the lowest suffix from 2 that is free.
          expect(name).toBe(lowestFree(implTaken));

          const res = cands[0].apply(position);
          expect(res.ok).toBe(true);
          const out = res.resultingSource!;
          expect(parsesCleanly(out)).toBe(true);
          expect(out).toContain(`function ${name}(`);
          expect(out).toContain(`${name}(`);
        }),
        { numRuns: 100 },
      );
    },
    300_000,
  );

  it(
    "selectFunctionName returns the base or the lowest free suffix from 2",
    () => {
      const arbTaken = fc
        .tuple(
          fc.subarray(NAMES),
          fc.array(fc.oneof(fc.string({ maxLength: 4 }), fc.constant(`${EXTRACT_BASE_NAME}1`)), {
            maxLength: 4,
          }),
        )
        .map(([a, b]) => new Set([...a, ...b]));
      fc.assert(
        fc.property(arbTaken, (taken) => {
          const name = selectFunctionName(EXTRACT_BASE_NAME, taken);
          expect(taken.has(name)).toBe(false);
          if (!taken.has(EXTRACT_BASE_NAME)) {
            expect(name).toBe(EXTRACT_BASE_NAME);
            return;
          }
          const m = new RegExp(`^${EXTRACT_BASE_NAME}(\\d+)$`).exec(name);
          expect(m).not.toBeNull();
          const k = Number(m![1]);
          expect(k).toBeGreaterThanOrEqual(2);
          for (let j = 2; j < k; j++) expect(taken.has(`${EXTRACT_BASE_NAME}${j}`)).toBe(true);
        }),
        { numRuns: 100 },
      );
    },
    300_000,
  );
});
