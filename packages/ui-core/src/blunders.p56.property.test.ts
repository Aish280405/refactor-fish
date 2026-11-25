// Feature: refactor-fish, Property 56: Blunder log empty-message indicator
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { blunderLogView, EMPTY_MESSAGE_INDICATOR } from "./blunders.js";
import type { BlunderRecord } from "./types.js";

/**
 * **Validates: Requirements 20.3**
 */

// A failing test either has no message (absent or empty) or a non-empty message.
const failingTest = fc.oneof(
  fc.record({ testName: fc.string({ minLength: 1 }) }),
  fc.record({ testName: fc.string({ minLength: 1 }), message: fc.constant("") }),
  fc.record({ testName: fc.string({ minLength: 1 }), message: fc.string({ minLength: 1 }).filter((m) => m !== EMPTY_MESSAGE_INDICATOR) }),
);

const blunder: fc.Arbitrary<BlunderRecord> = fc.record({
  moveDescription: fc.string({ minLength: 1 }),
  lineIndex: fc.integer({ min: 1, max: 20 }),
  failingTests: fc.array(failingTest, { minLength: 1, maxLength: 5 }),
});

describe("Property 56: Blunder log empty-message indicator", () => {
  it("shows the indicator iff the message is absent, and always shows the test name", () => {
    fc.assert(
      fc.property(fc.array(blunder, { maxLength: 6 }), (blunders) => {
        const view = blunderLogView(blunders);
        expect(view.entries).toHaveLength(blunders.length);
        blunders.forEach((b, i) => {
          const tests = view.entries[i]!.failingTests;
          expect(tests).toHaveLength(b.failingTests.length);
          b.failingTests.forEach((t, j) => {
            const v = tests[j]!;
            const absent = t.message === undefined || t.message === "";
            expect(v.testName).toBe(t.testName);
            expect(v.message === EMPTY_MESSAGE_INDICATOR).toBe(absent);
            expect(v.hasMessage).toBe(!absent);
            if (!absent) expect(v.message).toBe(t.message);
          });
        });
      }),
      { numRuns: 100 },
    );
  });
});
