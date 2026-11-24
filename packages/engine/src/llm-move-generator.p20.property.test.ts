// Feature: refactor-fish, Property 20: For any proposal returned by a mocked LLM_Provider that does not parse as valid TypeScript, the Engine SHALL discard it, add a discard-log entry containing the proposal and the parse-failure reason, and continue the Search using the remaining proposals.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FakeLLMProvider } from "../test-utils/index.js";
import { LLMMoveGenerator } from "./llm-move-generator.js";
import type { DiscardLogEntry, LLMMoveProposal, Position } from "./types.js";

const position: Position = { sourceText: "export const original = 0;\n", filePath: "target.ts" };

const ident = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,7}$/).map((s) => `v_${s}`);

/** Parses cleanly and always differs from the Position source (names are prefixed `v_`). */
const validSource = fc.oneof(
  fc.tuple(ident, fc.integer({ min: -1000, max: 1000 })).map(([n, v]) => `export const ${n} = ${v};\n`),
  ident.map((n) => `export function ${n}(a: number): number {\n  return a + 1;\n}\n`),
  fc.tuple(ident, ident).map(([a, b]) => `const ${a} = 1;\nexport const ${b} = ${a} > 0 ? "y" : "n";\n`),
);

/** Each template is a syntax error regardless of the identifier inserted. */
const invalidSource = fc.oneof(
  ident.map((n) => `export const ${n} = ;\n`),
  ident.map((n) => `function ${n}( {\n`),
  ident.map((n) => `let ${n} = [1, 2;\n`),
  ident.map((n) => `const ${n} = (;\n`),
  ident.map((n) => `class ${n} { method( }\n`),
  ident.map((n) => `export const ${n} = 1 +;\n`),
);

type Tagged = { valid: boolean; proposal: LLMMoveProposal };

const proposal = (valid: boolean, src: fc.Arbitrary<string>): fc.Arbitrary<Tagged> =>
  fc.tuple(fc.string({ maxLength: 12 }), src).map(([title, resultingSource]) => ({
    valid,
    proposal: { title, resultingSource },
  }));

const batch = fc.array(fc.oneof(proposal(true, validSource), proposal(false, invalidSource)), {
  minLength: 1,
  maxLength: 5,
});

describe("Property 20: LLM invalid-proposal discarding", () => {
  it(
    "discards every unparseable proposal with a parse-failure entry and keeps the valid ones in order",
    async () => {
      await fc.assert(
        fc.asyncProperty(batch, async (items) => {
          const provider = new FakeLLMProvider({ proposals: items.map((i) => i.proposal) });
          const discardLog: DiscardLogEntry[] = [];
          const candidates = await new LLMMoveGenerator().generate(position, {
            llmProvider: provider,
            discardLog,
          });

          const invalid = items.filter((i) => !i.valid).map((i) => i.proposal);
          const valid = items.filter((i) => i.valid).map((i) => i.proposal);

          // Every invalid proposal is discarded, in order, with its source and a non-empty reason.
          expect(discardLog).toHaveLength(invalid.length);
          discardLog.forEach((entry, k) => {
            expect(entry.kind).toBe("parse-failure");
            expect(entry.proposalSource).toBe(invalid[k].resultingSource);
            expect(entry.proposalTitle).toBe(invalid[k].title);
            expect(typeof entry.reason).toBe("string");
            expect(entry.reason.trim().length).toBeGreaterThan(0);
          });

          // The remaining proposals are still processed: each valid one becomes a candidate, in order.
          expect(candidates).toHaveLength(valid.length);
          candidates.forEach((c, k) => {
            expect(c.move).toBe("LLMMove");
            expect(c.apply(position)).toEqual({ ok: true, resultingSource: valid[k].resultingSource });
          });

          expect(provider.requestCount).toBe(1);
        }),
        { numRuns: 100 },
      );
    },
    300_000,
  );
});
