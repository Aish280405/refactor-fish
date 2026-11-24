import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { contentHash } from "./types.js";

describe("contentHash", () => {
  it("matches the known SHA-256 of the empty string", () => {
    expect(contentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic and differs for differing inputs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(contentHash(a)).toBe(contentHash(a));
        if (a !== b) expect(contentHash(a)).not.toBe(contentHash(b));
      }),
      { numRuns: 100 },
    );
  });
});
