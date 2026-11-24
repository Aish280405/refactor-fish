// Feature: refactor-fish, Property 45: For any 1-based index, Move display name, and Annotation, the formatted line SHALL equal exactly "<n>. <Move name> <Annotation>".
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatMoveLine } from "./annotator.js";
import type { Annotation } from "./types.js";

const arbAnnotation = fc.constantFrom<Annotation>("!!", "!", "?!", "??");

describe("Property 45: Move line formatting", () => {
  /** **Validates: Requirements 15.7** */
  it("formats as `<n>. <Move name> <Annotation>`", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.string({ minLength: 1 }),
        arbAnnotation,
        (n, name, annotation) => {
          const line = formatMoveLine(n, name, annotation);
          expect(line).toBe(`${n}. ${name} ${annotation}`);
          expect(line.startsWith(`${n}. `)).toBe(true);
          expect(line.endsWith(` ${annotation}`)).toBe(true);
          expect(line.slice(`${n}. `.length, line.length - annotation.length - 1)).toBe(name);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("example: 3. Inline Variable !!", () => {
    expect(formatMoveLine(3, "Inline Variable", "!!")).toBe("3. Inline Variable !!");
  });
});
