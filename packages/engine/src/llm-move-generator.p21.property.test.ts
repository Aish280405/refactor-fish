// Feature: refactor-fish, Property 21: LLM no-op proposal discarding
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbitraryPosition, FakeLLMProvider } from "../test-utils/index.js";
import { LLMMoveGenerator } from "./llm-move-generator.js";
import type { DiscardLogEntry, LLMMoveProposal, Position } from "./types.js";

type ProposalKind = "empty" | "whitespace" | "identical" | "changed";

interface ProposalSpec {
  kind: ProposalKind;
  /** Whitespace-only text, used when kind is "whitespace". */
  whitespace: string;
  /** Value of the declaration appended when kind is "changed". */
  value: number;
}

const arbitraryWhitespace = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r\n"), { minLength: 1, maxLength: 6 })
    .map((parts) => parts.join(""));

const arbitraryProposalSpec = (): fc.Arbitrary<ProposalSpec> =>
  fc.record({
    kind: fc.constantFrom<ProposalKind>("empty", "whitespace", "identical", "changed"),
    whitespace: arbitraryWhitespace(),
    value: fc.integer({ min: 0, max: 1000 }),
  });

function buildProposal(position: Position, spec: ProposalSpec, index: number): LLMMoveProposal {
  const title = `proposal-${index}`;
  switch (spec.kind) {
    case "empty":
      return { title, resultingSource: "" };
    case "whitespace":
      return { title, resultingSource: spec.whitespace };
    case "identical":
      return { title, resultingSource: position.sourceText };
    case "changed":
      // Appending a fresh exported declaration keeps the file valid TypeScript and differs from the Position.
      return {
        title,
        resultingSource: `${position.sourceText}\nexport const llmAdded${index} = ${spec.value};\n`,
      };
  }
}

describe("Property 21: LLM no-op proposal discarding", () => {
  /**
   * **Validates: Requirements 9.8**
   */
  it(
    "discards empty, whitespace-only, and identical proposals with a no-change entry and keeps changed ones",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPosition(),
          fc.array(arbitraryProposalSpec(), { minLength: 1, maxLength: 5 }),
          async (position, specs) => {
            const proposals = specs.map((spec, i) => buildProposal(position, spec, i));
            const provider = new FakeLLMProvider({ proposals });
            const discardLog: DiscardLogEntry[] = [];

            const candidates = await new LLMMoveGenerator().generate(position, {
              llmProvider: provider,
              discardLog,
            });

            const noOps = proposals.filter((_, i) => specs[i]!.kind !== "changed");
            const changed = proposals.filter((_, i) => specs[i]!.kind === "changed");

            // Each no-op proposal gets exactly one "no-change" entry, in order.
            expect(discardLog.map((e) => e.proposalTitle)).toEqual(noOps.map((p) => p.title));
            for (const entry of discardLog) {
              expect(entry.kind).toBe("no-change");
              expect(entry.reason).toMatch(/no change/i);
            }

            // Only changed proposals become candidates, with their proposed source.
            expect(candidates.map((c) => c.displayName)).toEqual(changed.map((p) => p.title));
            const resulting = candidates.map((c) => c.apply(position));
            expect(resulting).toEqual(changed.map((p) => ({ ok: true, resultingSource: p.resultingSource })));

            // No candidate carries a no-op source.
            for (const r of resulting) {
              if (!r.ok) continue;
              expect(r.resultingSource.trim().length).toBeGreaterThan(0);
              expect(r.resultingSource).not.toBe(position.sourceText);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    300_000,
  );
});
