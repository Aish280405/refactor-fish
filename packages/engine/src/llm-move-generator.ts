import { syntaxErrors } from "./ast-editor.js";
import type {
  ApplyResult,
  Candidate,
  GeneratorContext,
  LLMMoveProposal,
  MoveGenerator,
  Position,
} from "./types.js";

export type { LLMMoveProposal, LLMProvider } from "./types.js";

export const LLM_MAX_PROPOSALS = 5;
export const LLM_TIMEOUT_MS = 30_000;

/** Recorded when the provider errors or times out for a Position (Requirement 9.4). */
export interface LLMFailureRecord {
  /** Source text of the Position being expanded. */
  position: Position;
  failureKind: "error" | "timeout";
  message?: string;
}

export interface LLMMoveGeneratorOptions {
  /** Appended to on provider error or timeout. */
  failures?: LLMFailureRecord[];
  maxProposals?: number;
  timeoutMs?: number;
}

class TimeoutSignal {}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Generates LLM_Move candidates. Its output enters the same legality pipeline as deterministic moves. */
export class LLMMoveGenerator implements MoveGenerator {
  readonly failures: LLMFailureRecord[];
  private readonly maxProposals: number;
  private readonly timeoutMs: number;

  constructor(options: LLMMoveGeneratorOptions = {}) {
    this.failures = options.failures ?? [];
    this.maxProposals = options.maxProposals ?? LLM_MAX_PROPOSALS;
    this.timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  }

  async generate(position: Position, context: GeneratorContext): Promise<Candidate[]> {
    const provider = context.llmProvider;
    if (!provider) return []; // 9.5: no requests without a provider

    // 9.7: the request carries only this Position's source text.
    const request: Position = { sourceText: position.sourceText, filePath: position.filePath };

    let proposals: LLMMoveProposal[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<TimeoutSignal>((resolve) => {
        timer = setTimeout(() => resolve(new TimeoutSignal()), this.timeoutMs);
      });
      // 9.1: one request, at most 5 proposals; 9.4: no retry.
      const result = await Promise.race([
        provider.proposeMoves(request, this.maxProposals, this.timeoutMs),
        timeout,
      ]);
      if (result instanceof TimeoutSignal) {
        this.failures.push({ position, failureKind: "timeout" });
        return [];
      }
      proposals = result;
    } catch (err) {
      this.failures.push({
        position,
        failureKind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!Array.isArray(proposals)) return [];

    const candidates: Candidate[] = [];
    for (const proposal of proposals.slice(0, this.maxProposals)) {
      const source = proposal.resultingSource;
      const title = proposal.title;

      // 9.8: empty or identical proposals make no change.
      if (typeof source !== "string" || isBlank(source) || source === position.sourceText) {
        context.discardLog.push({
          kind: "no-change",
          reason: "proposal made no change",
          proposalTitle: title,
          proposalSource: typeof source === "string" ? source : undefined,
        });
        continue;
      }

      // 9.3: discard unparseable proposals.
      const errors = syntaxErrors(source, position.filePath);
      if (errors.length > 0) {
        context.discardLog.push({
          kind: "parse-failure",
          reason: errors[0],
          proposalTitle: title,
          proposalSource: source,
        });
        continue;
      }

      candidates.push(makeCandidate(title, source));
    }
    return candidates;
  }
}

function makeCandidate(title: string, resultingSource: string): Candidate {
  const displayName = title && title.trim().length > 0 ? title : "LLM move";
  return {
    move: "LLMMove",
    displayName,
    describe: () => `LLM move: ${displayName}`,
    apply(): ApplyResult {
      return { ok: true, resultingSource };
    },
  };
}
