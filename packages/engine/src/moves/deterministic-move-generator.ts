import type {
  ApplyResult,
  Candidate,
  GeneratorContext,
  MoveGenerator,
  MoveKind,
  Position,
} from "../types.js";
import { generateExtractFunctionCandidates } from "./extract-function.js";
import { generateGuardClauseCandidates } from "./guard-clause.js";
import { generateInlineVariable } from "./inline-variable.js";
import { generateRemoveUnused } from "./remove-unused.js";
import { generateSimplifyBoolean } from "./simplify-boolean.js";

export type SubGenerator = (position: Position) => Candidate[];

/**
 * The deterministic catalog, in fixed catalog order (Requirement 12.2).
 * Each sub-generator returns its candidates in source order (by node start),
 * and each candidate's apply() runs its edit through the AST Editor's
 * `safeApply` wrapper.
 */
export const DETERMINISTIC_CATALOG: ReadonlyArray<{ kind: MoveKind; generate: SubGenerator }> = [
  { kind: "RemoveUnused", generate: generateRemoveUnused },
  { kind: "InlineVariable", generate: generateInlineVariable },
  { kind: "GuardClause", generate: generateGuardClauseCandidates },
  { kind: "SimplifyBoolean", generate: generateSimplifyBoolean },
  { kind: "ExtractFunction", generate: generateExtractFunctionCandidates },
];

/**
 * Last-resort guard so a candidate's apply() never throws. The sub-generators
 * already route their edits through `safeApply`; this only catches failures
 * that happen outside that wrapper.
 */
function neverThrow(candidate: Candidate): Candidate {
  return {
    move: candidate.move,
    displayName: candidate.displayName,
    describe: () => candidate.describe(),
    apply(position: Position): ApplyResult {
      try {
        return candidate.apply(position);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { reason: `Edit failed: ${msg}` } };
      }
    },
  };
}

export class DeterministicMoveGenerator implements MoveGenerator {
  constructor(private readonly catalog: ReadonlyArray<{ kind: MoveKind; generate: SubGenerator }> = DETERMINISTIC_CATALOG) {}

  /** Synchronous core; the same Position always yields the same ordered list. */
  generateSync(position: Position): Candidate[] {
    const out: Candidate[] = [];
    for (const entry of this.catalog) {
      let candidates: Candidate[];
      try {
        candidates = entry.generate(position);
      } catch {
        // A sub-generator that cannot analyze this Position contributes nothing.
        continue;
      }
      for (const c of candidates) out.push(neverThrow(c));
    }
    return out;
  }

  async generate(position: Position, _context: GeneratorContext): Promise<Candidate[]> {
    return this.generateSync(position);
  }
}
