import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { validateTargetFile } from "./args.js";

// Feature: refactor-fish, Property 2: Parse-error location reporting
// **Validates: Requirements 1.5**

const invalidSnippets = [
  "const x = ;",
  "function (",
  "const = 5;",
  "if (x {",
  "const a = [1, 2;",
  "foo(1, 2;",
  "let 1abc = 2;",
  "var x = (;",
  "}",
];

const validLine = fc.nat(999).map((n) => `const v${n} = ${n};`);
const path = fc.constantFrom("a.ts", "src/b.ts", "dir/c.tsx");

describe("Property 2: Parse-error location reporting", () => {
  it("reports file path, line and column that map to a real position in the source", () => {
    fc.assert(
      fc.property(
        path,
        fc.array(validLine, { maxLength: 6 }),
        fc.constantFrom(...invalidSnippets),
        fc.array(validLine, { maxLength: 4 }),
        (p, before, bad, after) => {
          const lines = [...before, bad, ...after];
          const source = lines.join("\n");
          const res = validateTargetFile(p, { exists: () => true, readText: () => source });
          expect(res.ok).toBe(false);
          if (res.ok) return;
          expect(res.error).toContain(p);
          const m = /line (\d+), column (\d+)/.exec(res.error);
          expect(m).not.toBeNull();
          const line = Number(m![1]);
          const col = Number(m![2]);
          expect(line).toBeGreaterThanOrEqual(1);
          expect(line).toBeLessThanOrEqual(lines.length);
          expect(col).toBeGreaterThanOrEqual(1);
          expect(col).toBeLessThanOrEqual(lines[line - 1].length + 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
