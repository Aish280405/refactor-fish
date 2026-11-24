import { describe, expect, it } from "vitest";
import { createTestCache } from "./test-cache.js";
import { contentHash } from "./types.js";

describe("TestCache", () => {
  it("returns undefined on miss and the stored outcome on hit", () => {
    const cache = createTestCache();
    const h = contentHash("const a = 1;");
    expect(cache.get(h)).toBeUndefined();
    const outcome = { kind: "failed" as const, failures: [{ testName: "t", message: "m" }] };
    cache.set(h, { outcome });
    expect(cache.get(h)?.outcome).toEqual(outcome);
  });

  it("instances do not share state", () => {
    const a = createTestCache();
    const b = createTestCache();
    a.set("h", { outcome: { kind: "passed" } });
    expect(b.get("h")).toBeUndefined();
  });
});
