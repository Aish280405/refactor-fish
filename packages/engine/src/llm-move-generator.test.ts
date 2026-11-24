import { describe, expect, it, vi } from "vitest";
import { LLMMoveGenerator } from "./llm-move-generator.js";
import type { DiscardLogEntry, LLMProvider, Position } from "./types.js";

const position: Position = { sourceText: "export const a = 1;\n", filePath: "target.ts" };

function ctx(provider?: LLMProvider) {
  const discardLog: DiscardLogEntry[] = [];
  return { llmProvider: provider, discardLog };
}

function provider(fn: LLMProvider["proposeMoves"]) {
  const spy = vi.fn(fn);
  return { proposeMoves: spy } as LLMProvider & { proposeMoves: typeof spy };
}

describe("LLMMoveGenerator", () => {
  it("sends no requests and returns nothing without a provider", async () => {
    const gen = new LLMMoveGenerator();
    expect(await gen.generate(position, ctx())).toEqual([]);
  });

  it("sends one request with only the position text, max 5, 30s", async () => {
    const p = provider(async () => []);
    await new LLMMoveGenerator().generate(position, ctx(p));
    expect(p.proposeMoves).toHaveBeenCalledTimes(1);
    expect(p.proposeMoves).toHaveBeenCalledWith(
      { sourceText: position.sourceText, filePath: "target.ts" },
      5,
      30_000,
    );
  });

  it("returns candidates for valid proposals and discards invalid and no-op ones", async () => {
    const p = provider(async () => [
      { title: "good", resultingSource: "export const a = 2;\n" },
      { title: "bad", resultingSource: "export const = ;" },
      { title: "same", resultingSource: position.sourceText },
      { title: "empty", resultingSource: "  \n" },
    ]);
    const c = ctx(p);
    const out = await new LLMMoveGenerator().generate(position, c);
    expect(out).toHaveLength(1);
    expect(out[0].move).toBe("LLMMove");
    expect(out[0].apply(position)).toEqual({ ok: true, resultingSource: "export const a = 2;\n" });
    expect(c.discardLog.map((d) => d.kind)).toEqual(["parse-failure", "no-change", "no-change"]);
    expect(c.discardLog[0].proposalSource).toBe("export const = ;");
    expect(c.discardLog[0].reason.length).toBeGreaterThan(0);
  });

  it("records provider errors without retrying", async () => {
    const p = provider(async () => {
      throw new Error("boom");
    });
    const gen = new LLMMoveGenerator();
    expect(await gen.generate(position, ctx(p))).toEqual([]);
    expect(p.proposeMoves).toHaveBeenCalledTimes(1);
    expect(gen.failures).toEqual([{ position, failureKind: "error", message: "boom" }]);
  });

  it("records a timeout after 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const p = provider(() => new Promise(() => {}));
      const gen = new LLMMoveGenerator();
      const pending = gen.generate(position, ctx(p));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual([]);
      expect(gen.failures).toEqual([{ position, failureKind: "timeout" }]);
      expect(p.proposeMoves).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
