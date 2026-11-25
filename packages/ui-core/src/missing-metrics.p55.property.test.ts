// Feature: refactor-fish, Property 55: Missing-metrics placeholder handling
// **Validates: Requirements 19.6**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { METRIC_KEYS, UNAVAILABLE, metricsPanelView } from "./metrics.js";
import type { Metrics } from "./types.js";

const arbSide = fc.record({
  values: fc.record({
    cyclomaticComplexity: fc.integer({ min: 0, max: 1000 }),
    maxNestingDepth: fc.integer({ min: 0, max: 1000 }),
    functionLength: fc.integer({ min: 0, max: 1000 }),
    duplicatedCode: fc.integer({ min: 0, max: 1000 }),
    unusedCode: fc.integer({ min: 0, max: 1000 }),
  }),
  missing: fc.record({
    cyclomaticComplexity: fc.boolean(),
    maxNestingDepth: fc.boolean(),
    functionLength: fc.boolean(),
    duplicatedCode: fc.boolean(),
    unusedCode: fc.boolean(),
  }),
  useNull: fc.boolean(),
});

type Side = typeof arbSide extends fc.Arbitrary<infer T> ? T : never;

function build(side: Side): Partial<Record<(typeof METRIC_KEYS)[number], number | null>> {
  const out: Partial<Record<(typeof METRIC_KEYS)[number], number | null>> = {};
  for (const k of METRIC_KEYS) {
    if (!side.missing[k]) out[k] = side.values[k];
    else if (side.useNull) out[k] = null;
  }
  return out;
}

describe("Property 55: Missing-metrics placeholder handling", () => {
  it("shows 'unavailable' exactly for missing fields and real values otherwise", () => {
    fc.assert(
      fc.property(arbSide, arbSide, (o, s) => {
        const rows = metricsPanelView(
          build(o) as Partial<Metrics>,
          build(s) as Partial<Metrics>,
        );
        expect(rows).toHaveLength(METRIC_KEYS.length);
        for (const row of rows) {
          const k = row.key;
          const oMissing = o.missing[k];
          const sMissing = s.missing[k];
          expect(row.original).toBe(oMissing ? UNAVAILABLE : String(o.values[k]));
          expect(row.selected).toBe(sMissing ? UNAVAILABLE : String(s.values[k]));
          if (oMissing || sMissing) {
            expect(row.change).toBe(UNAVAILABLE);
            expect(row.mark).toBeNull();
          } else {
            expect(row.change).not.toBe(UNAVAILABLE);
            expect(row.mark).not.toBeNull();
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
