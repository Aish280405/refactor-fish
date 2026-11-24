import type {
  CoverageResult,
  LLMMoveProposal,
  LLMProviderLike,
  Position,
  TestOutcome,
  TestRunnerLike,
} from "./types.js";

export type OutcomeResolver = (position: Position, relevantTestFile: string) => TestOutcome | Promise<TestOutcome>;

export interface FakeTestRunnerOptions {
  /** Outcome per exact source text. Takes precedence over `resolve`. */
  outcomes?: Map<string, TestOutcome> | Record<string, TestOutcome>;
  /** Computed outcome for any other Position. */
  resolve?: OutcomeResolver;
  /** Used when nothing else matches. Default: `{ kind: "passed" }`. */
  defaultOutcome?: TestOutcome;
  /** Coverage returned by `runWithCoverage`. Default: 100%. */
  coverage?: CoverageResult;
}

/** In-process TestRunner. Never spawns Vitest. Records every call. */
export class FakeTestRunner implements TestRunnerLike {
  readonly calls: { position: Position; relevantTestFile: string }[] = [];
  private readonly outcomes: Map<string, TestOutcome>;

  constructor(private readonly options: FakeTestRunnerOptions = {}) {
    const o = options.outcomes;
    this.outcomes = o instanceof Map ? new Map(o) : new Map(Object.entries(o ?? {}));
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** Source texts passed to `run`, in call order. */
  get runSources(): string[] {
    return this.calls.map((c) => c.position.sourceText);
  }

  setOutcome(sourceText: string, outcome: TestOutcome): void {
    this.outcomes.set(sourceText, outcome);
  }

  async run(position: Position, relevantTestFile: string): Promise<TestOutcome> {
    this.calls.push({ position, relevantTestFile });
    const fixed = this.outcomes.get(position.sourceText);
    if (fixed) return fixed;
    if (this.options.resolve) return this.options.resolve(position, relevantTestFile);
    return this.options.defaultOutcome ?? { kind: "passed" };
  }

  async runWithCoverage(
    position: Position,
    relevantTestFile: string,
  ): Promise<{ outcome: TestOutcome; coverage: CoverageResult }> {
    const outcome = await this.run(position, relevantTestFile);
    return { outcome, coverage: this.options.coverage ?? { percent: 100, unknown: false } };
  }
}

export type ProposalResolver = (
  position: Position,
  maxProposals: number,
  timeoutMs: number,
) => LLMMoveProposal[] | Promise<LLMMoveProposal[]>;

export interface FakeLLMProviderOptions {
  /** Fixed proposals returned for every request. */
  proposals?: LLMMoveProposal[];
  /** Computed proposals; takes precedence over `proposals`. */
  resolve?: ProposalResolver;
  /** When set, every request rejects with this error (provider failure). */
  failWith?: Error;
  /** When true, every request never settles on its own (use with fake timers to model a timeout). */
  hang?: boolean;
}

/** LLMProvider fake. Never touches the network. Records every request. */
export class FakeLLMProvider implements LLMProviderLike {
  readonly requests: { position: Position; maxProposals: number; timeoutMs: number }[] = [];

  constructor(private readonly options: FakeLLMProviderOptions = {}) {}

  get requestCount(): number {
    return this.requests.length;
  }

  /** Every string the provider has been sent; used to assert the payload is only the Position source. */
  get payloads(): string[] {
    return this.requests.map((r) => r.position.sourceText);
  }

  proposeMoves(position: Position, maxProposals: number, timeoutMs: number): Promise<LLMMoveProposal[]> {
    this.requests.push({ position, maxProposals, timeoutMs });
    if (this.options.hang) return new Promise<LLMMoveProposal[]>(() => {});
    if (this.options.failWith) return Promise.reject(this.options.failWith);
    if (this.options.resolve) return Promise.resolve(this.options.resolve(position, maxProposals, timeoutMs));
    return Promise.resolve([...(this.options.proposals ?? [])]);
  }
}
