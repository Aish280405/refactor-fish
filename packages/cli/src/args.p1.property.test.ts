// Feature: refactor-fish, Property 1: Extension validation
// For any file path, the CLI SHALL accept it iff it ends in .ts or .tsx.
// **Validates: Requirements 1.4**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hasSupportedExtension, validateTargetFile, type FileReader } from "./args.js";

const fsFor = (): FileReader => ({ exists: () => true, readText: () => "const a = 1;\n" });

const arbBase = fc.string({ minLength: 1, maxLength: 20 });
const arbAccepted = fc.tuple(arbBase, fc.constantFrom(".ts", ".tsx")).map(([b, e]) => b + e);
const arbRejected = fc
  .oneof(
    fc.string({ maxLength: 30 }),
    fc.tuple(arbBase, fc.constantFrom(".js", ".jsx", ".tsx.bak", ".ts.", ".TS", ".TSX", ".d", "ts", "tsx", ".mts", ".json", "")).map(([b, e]) => b + e),
  )
  .filter((p) => !p.endsWith(".ts") && !p.endsWith(".tsx"));

describe("Property 1: Extension validation", () => {
  it("accepts any path ending in .ts or .tsx", () => {
    fc.assert(
      fc.property(arbAccepted, (p) => {
        expect(hasSupportedExtension(p)).toBe(true);
        expect(validateTargetFile(p, fsFor()).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects any path not ending in .ts or .tsx", () => {
    fc.assert(
      fc.property(arbRejected, (p) => {
        expect(hasSupportedExtension(p)).toBe(false);
        const r = validateTargetFile(p, fsFor());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("Unsupported file extension");
      }),
      { numRuns: 100 },
    );
  });
});
