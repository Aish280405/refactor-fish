import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { validateCliArgs, type FileReader } from "./args.js";

const fsWith = (files: Record<string, string>): FileReader => ({
  exists: (p) => p in files,
  readText: (p) => files[p],
});

// Feature: refactor-fish, Property 40: Depth-option validation
describe("Property 40: Depth-option validation", () => {
  const fs = fsWith({ "a.ts": "export const x = 1;\n" });

  it("accepts only integer 3 or 4; otherwise errors with the accepted range and does not proceed to Search", () => {
    // **Validates: Requirements 14.4, 14.5**
    const depthArb = fc.oneof(
      fc.constantFrom("3", "4"),
      fc.integer({ min: -1000, max: 1000 }).map(String),
      fc.double({ noNaN: false }).map(String),
      fc.string(),
    );
    fc.assert(
      fc.property(depthArb, fc.boolean(), (raw, useEquals) => {
        const argv = useEquals ? ["analyze", "a.ts", `--depth=${raw}`] : ["analyze", "a.ts", "--depth", raw];
        const r = validateCliArgs(argv, fs);
        if (raw === "3" || raw === "4") {
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.options.depth).toBe(Number(raw));
        } else {
          expect(r.ok).toBe(false);
          if (!r.ok) {
            expect(r.error).toContain("3 or 4");
            expect(r.error).toContain("3-4");
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
