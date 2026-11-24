import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeLLMProvider } from "../test-utils/index.js";
import { LLMMoveGenerator, LLM_TIMEOUT_MS } from "./llm-move-generator.js";
import { DeterministicMoveGenerator } from "./moves/deterministic-move-generator.js";
import type { Candidate, DiscardLogEntry, GeneratorContext, LLMProvider, Position } from "./types.js";

// Small Position with at least one deterministic candidate (an unused top-level const).
const position: Position = {
  sourceText: `const unusedVar = 1;\nexport function f(): number {\n  return 1;\n}\n`,
  filePath: "target.ts",
};

const llmProposal = { title: "rename", resultingSource: `export function f(): number {\n  return 2;\n}\n` };

function ctx(provider?: LLMProvider): GeneratorContext & { discardLog: DiscardLogEntry[] } {
  return { llmProvider: provider, discardLog: [] };
}

/** Expands a Position the way the Search does: deterministic candidates plus LLM candidates. */
async function expand(llm: LLMMoveGenerator, p: Position, c: GeneratorContext): Promise<Candidate[]> {
  const [det, fromLlm] = await Promise.all([new DeterministicMoveGenerator().generate(p, c), llm.generate(p, c)]);
  return [...det, ...fromLlm];
}

const summarize = (cs: Candidate[]) => cs.map((c) => `${c.move}:${c.describe()}`);

const deterministicOnly = async () => summarize(await new DeterministicMoveGenerator().generate(position, ctx()));

afterEach(() => {
  vi.useRealTimers();
});

describe("LLMMoveGenerator behaviors (Requirement 9)", () => {
  // Requirement 9.5
  it("with no provider configured, sends zero requests and yields deterministic moves only", async () => {
    const unused = new FakeLLMProvider({ proposals: [llmProposal] });
    const llm = new LLMMoveGenerator();
    const out = await expand(llm, position, ctx());

    expect(unused.requestCount).toBe(0);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.move !== "LLMMove")).toBe(true);
    expect(summarize(out)).toEqual(await deterministicOnly());
    expect(llm.failures).toEqual([]);
  });

  // Requirement 9.7
  it("sends only the Target_File content of the Position being expanded", async () => {
    const provider = new FakeLLMProvider({ proposals: [] });
    const llm = new LLMMoveGenerator();
    // Extra fields on the Position (e.g. other files' content) must not reach the provider.
    const withExtras = { ...position, otherFiles: { "other.ts": "secret" } } as Position;
    const next: Position = { sourceText: llmProposal.resultingSource, filePath: "target.ts" };

    await llm.generate(withExtras, ctx(provider));
    await llm.generate(next, ctx(provider));

    expect(provider.payloads).toEqual([position.sourceText, next.sourceText]);
    for (const r of provider.requests) {
      expect(Object.keys(r.position).sort()).toEqual(["filePath", "sourceText"]);
      expect(JSON.stringify(r.position)).not.toContain("secret");
    }
  });

  // Requirement 9.4 (error)
  it("on provider error, still yields the deterministic moves and records the error", async () => {
    const provider = new FakeLLMProvider({ failWith: new Error("provider down") });
    const llm = new LLMMoveGenerator();
    const out = await expand(llm, position, ctx(provider));

    expect(provider.requestCount).toBe(1);
    expect(summarize(out)).toEqual(await deterministicOnly());
    expect(llm.failures).toEqual([{ position, failureKind: "error", message: "provider down" }]);
  });

  // Requirement 9.4 (timeout)
  it("on a 30 s timeout, still yields the deterministic moves and records the timeout", async () => {
    vi.useFakeTimers();
    const provider = new FakeLLMProvider({ hang: true });
    const llm = new LLMMoveGenerator();
    let settled = false;
    const pending = expand(llm, position, ctx(provider)).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    vi.useRealTimers();

    expect(provider.requestCount).toBe(1);
    expect(provider.requests[0].timeoutMs).toBe(30_000);
    expect(summarize(out)).toEqual(await deterministicOnly());
    expect(llm.failures).toEqual([{ position, failureKind: "timeout" }]);
  });

  // Requirement 9.6: the "tests failed" discard entry is written by the CandidateEvaluator,
  // which runs the tests on each candidate. It does not exist yet; see task 14.1.
  it.todo('adds a "tests-failed" discard entry and excludes an LLM move whose Position fails the tests (task 14.1)');
});
