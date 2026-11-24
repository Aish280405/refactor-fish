# Design Document

## Overview

Refactor-fish analyzes one TypeScript file at a time using a chess-engine metaphor: the file's source text is a **Position**, a syntax-tree edit is a **Move**, and a failing test is a **Blunder**. The Engine performs a beam search over sequences of Moves (**Lines**), testing every candidate Position against the project's Vitest suite before it is allowed to count as progress, and scoring only test-passing Positions with a fixed set of code-quality **Metrics**. The user triggers this from a CLI command, watches it unfold in a local Web UI (eval bar, move list, diff viewer, metrics panel, blunder log), and decides whether to write the result back to disk. A separate static **Replay Demo** renders a pre-recorded analysis of a **Sample Project** using the same rendering code as the live Web UI, driven by a shared **Recording** JSON format.

The guiding rules from the requirements translate directly into architectural commitments:

- **Tests always decide** → every candidate Position must pass through the `TestRunner` and be classified `Legal_Move` or `Blunder` before the `Evaluator` or `Search` can use it. There is no code path that scores or accepts a Position without a test result.
- **The LLM only suggests** → `LLMMoveGenerator` produces candidate edits exactly like `DeterministicMoveGenerator`; its output enters the same legality pipeline and gets no special trust.
- **The engine never writes to user files without approval** → all search activity operates on in-memory ts-morph source files (or temp-directory copies for test execution). The only code path that touches the real `Target_File` on disk is the explicit "Apply" action in the CLI/Web UI, gated by a byte-identical freshness check and a final test run.

## Architecture

### High-level components

```mermaid
graph TB
    subgraph CLI_Process["CLI Process (node)"]
        CLI[CLI]
        Engine[Engine]
        MoveGen[Move Generator]
        DetGen[Deterministic Move Generator]
        LLMGen[LLM Move Generator]
        AST[AST Editor - ts-morph]
        TestRunner[Test Runner - Vitest API]
        Cache[Test Cache]
        Evaluator[Evaluator]
        Search[Beam Search]
        RecWriter[Recording Writer]
        WebServer[Web UI Server - local HTTP/WS]
    end

    subgraph Browser["Browser"]
        WebUI[Web UI - live]
    end

    subgraph Static["Static Hosting"]
        ReplayDemo[Replay Demo]
        RecordingAsset[Recording JSON asset]
    end

    LLMProvider[(LLM Provider API)]

    CLI --> Engine
    Engine --> MoveGen
    MoveGen --> DetGen
    MoveGen --> LLMGen
    LLMGen -. HTTPS .-> LLMProvider
    DetGen --> AST
    LLMGen --> AST
    Engine --> TestRunner
    TestRunner --> Cache
    Engine --> Evaluator
    Engine --> Search
    Search --> Engine
    Engine --> RecWriter
    RecWriter --> WebServer
    WebServer -- WebSocket/HTTP --> WebUI
    RecWriter -. recording.json .-> RecordingAsset
    ReplayDemo --> RecordingAsset
```

### Process and data flow

1. **CLI** parses arguments, validates the Target_File, and starts the **Engine** and **Web UI Server** in the same Node process.
2. The Engine runs a **pre-flight check** (Requirement 2/3): locate the Relevant_Test_File, run it once against the original Position, measure coverage. Failures here stop before any Search starts.
3. The **Beam Search** drives expansion: at each depth it asks the **Move Generator** (which fans out to the **Deterministic Move Generator** and, if configured, the **LLM Move Generator**) for candidate Moves on each kept Position.
4. Each candidate Move is applied by the **AST Editor** (ts-morph) to produce a new candidate Position's source text, hashed, and checked against the **Test Cache**. On a cache miss, the **Test Runner** executes the Relevant_Test_File against that candidate (via a temp-directory copy, never the real Target_File) and the result is stored in the cache and classified as `Legal_Move` or `Blunder`.
5. Legal candidates are scored by the **Evaluator** and fed back into the beam; the Search keeps the top `Beam_Width` Positions per depth and emits progress events to the **Recording Writer**, which forwards them to the **Web UI Server** over a WebSocket.
6. When the Search completes, the Engine finalizes the **Best_Line**, annotates each Move, and the **Recording Writer** produces the full **Recording** document.
7. The **Web UI** (served locally) and the **Replay Demo** (static, hosted) both consume the same Recording shape through a shared rendering module, so Requirement 16.3 (identical rendering) is satisfied by construction rather than by convention.
8. **Apply** is a distinct, explicit code path: it re-reads the Target_File from disk, compares it byte-for-byte to the original Position, re-runs the Relevant_Test_File against the Position to be written, and only then writes.

### Why these boundaries

- **In-memory-first, disk-only-on-apply**: Running the Search entirely against in-memory ts-morph projects and temp copies makes "the engine never writes to user files without approval" a structural property, not a discipline every code path has to remember. It also makes Requirement 10.6 (Target_File byte-identical before/after any test run) trivial to satisfy — the candidate under test is never the real file.
- **Shared rendering module** between Web UI and Replay Demo: Requirement 16.3 and Requirement 22.3 both require identical display behavior from the same data. A single rendering package consumed by both a small Express/ws server (live) and a static bundle (replay) avoids divergence.
- **Move Generator as a fan-out, not a merge point of trust**: Requirement 9.2 requires LLM_Moves to be "treated as a candidate like any other." Keeping `DeterministicMoveGenerator` and `LLMMoveGenerator` as peers behind one `MoveGenerator` interface, both emitting the same `Candidate` shape, enforces this at the type level.

## Components and Interfaces

### CLI

Responsibilities: argument parsing, file/extension/parse validation, port selection, browser launch, exit codes (Requirement 1), depth option validation (Requirement 14.4–14.5), and the Apply/Reject flow (Requirement 21).

```typescript
interface CliOptions {
  file: string;
  depth?: number;       // must be 3 or 4 if provided
  port?: number;
  noOpenBrowser?: boolean;
}

interface CliResult {
  exitCode: number;
}

function runCli(argv: string[]): Promise<CliResult>;
```

### Engine

Orchestrates pre-flight checks, the Search, and Recording assembly. It owns the lifetime of the Test Cache (Requirement 11.5) and the LLM discard log (Requirement 9.3/9.6/9.8).

```typescript
interface PreflightResult {
  status: "no-tests" | "tests-failed" | "tests-unrunnable" | "ok";
  relevantTestFile?: string;
  failingTests?: TestFailure[];
  coverage?: CoverageResult;
}

interface AnalysisOptions {
  targetFilePath: string;
  searchDepth: 3 | 4;
  beamWidth: number;          // default 3
  llmProvider?: LLMProvider;  // undefined => deterministic-only
  onProgress?: (event: ProgressEvent) => void;
}

interface AnalysisResult {
  recording: Recording;
}

class Engine {
  runPreflight(targetFilePath: string): Promise<PreflightResult>;
  analyze(options: AnalysisOptions): Promise<AnalysisResult>;
}
```

### Move Generator

A single interface implemented by the deterministic catalog and by the LLM-backed generator; the Engine treats both uniformly.

```typescript
type MoveKind =
  | "RemoveUnused"
  | "InlineVariable"
  | "GuardClause"
  | "SimplifyBoolean"
  | "ExtractFunction"
  | "LLMMove";

interface Candidate {
  move: MoveKind;
  displayName: string;          // e.g. "Guard clause", or LLM-provided title
  describe(): string;           // human-readable description, stored in logs/Recording
  apply(position: Position): ApplyResult; // pure: does not mutate `position`
}

interface ApplyResult {
  ok: boolean;
  resultingSource?: string;     // present when ok
  error?: { reason: string };   // present when !ok
}

interface MoveGenerator {
  generate(position: Position, context: GeneratorContext): Promise<Candidate[]>;
}

interface GeneratorContext {
  llmProvider?: LLMProvider;
  discardLog: DiscardLogEntry[]; // appended to for LLM discards (9.3, 9.6, 9.8)
}
```

- `DeterministicMoveGenerator implements MoveGenerator`: internally delegates to five pure sub-generators (`RemoveUnusedGenerator`, `InlineVariableGenerator`, `GuardClauseGenerator`, `SimplifyBooleanGenerator`, `ExtractFunctionGenerator`), each returning `Candidate[]` in a fixed, stable order (Requirement 12.2). The overall order concatenates sub-generators in catalog order, and within each sub-generator, in source order (by node start position).
- `LLMMoveGenerator implements MoveGenerator`: sends one request per expansion (Requirement 9.1), applies the 30-second timeout, parse-check (ts-morph `createSourceFile` + `getPreEmitDiagnostics`-free syntactic check) and empty/no-op check, and writes discard entries rather than throwing.

### AST Editor

Wraps ts-morph. Every Move's `apply()` ultimately goes through this layer, which guarantees: parse-validity of the result, comment preservation, and no mutation of the input Position.

```typescript
interface Position {
  readonly sourceText: string;
  readonly filePath: string;    // virtual path, e.g. "target.ts", used for the in-memory project
}

interface AstEditor {
  // Loads `position` into a fresh in-memory ts-morph Project + TypeChecker.
  load(position: Position): EditableUnit;
}

interface EditableUnit {
  getSourceFile(): SourceFile;         // ts-morph SourceFile
  getTypeChecker(): TypeChecker;       // for exact-boolean type checks (Req 7)
  // Returns new, independent source text; never mutates `position.sourceText`.
  commit(): string;
}
```

Design notes:

- Each `apply()` call creates its **own** `ts-morph` `Project` (`useInMemoryFileSystem: true`) seeded with the candidate's starting source text, so Positions are always immutable value objects — this directly supports Requirement 12.1 and 12.3 (determinism, double-apply byte-identical) because there is no shared mutable AST between calls.
- Comment preservation (Requirement 12.4) relies on ts-morph's trivia-preserving manipulation API (`node.replaceWithText`, structure-based transforms) rather than full re-printing, and is verified by a dedicated property test (see Testing Strategy).
- Exact-boolean checks for Requirement 7 use `typeChecker.getTypeAtLocation(node)` and reject when the type is not exactly `boolean` (union types, `any`, and `unknown` are excluded by comparing the type's flags against `ts.TypeFlags.Boolean`/`BooleanLiteral` only, unioned, with no other flags present).

### Test Runner

```typescript
interface TestFailure {
  testName: string;
  message?: string;
}

type TestOutcome =
  | { kind: "passed" }
  | { kind: "failed"; failures: TestFailure[] }
  | { kind: "error"; message: string }      // unrunnable: syntax error, missing dep, 0 tests
  | { kind: "timeout" };

interface CoverageResult {
  percent: number;        // 0-100, one decimal place
  unknown: boolean;       // true if coverage could not be measured
}

interface TestRunner {
  run(position: Position, relevantTestFile: string): Promise<TestOutcome>;
  runWithCoverage(position: Position, relevantTestFile: string): Promise<{ outcome: TestOutcome; coverage: CoverageResult }>;
}
```

Implementation approach: for each run, materialize the candidate Position's source into a **temp directory** that mirrors the project structure (so relative imports resolve), using the project's real `node_modules` via a symlink or `cwd` override, then invoke Vitest's programmatic API (`startVitest`/`createVitest` from the `vitest/node` entry point) scoped to exactly the Relevant_Test_File, with a 60-second timeout (Requirement 10.7) enforced by the caller racing the run against a timer and killing the Vitest instance on expiry. Coverage uses `@vitest/coverage-v8`'s JSON reporter (`coverage-final.json`, Istanbul-shaped `statementMap`) to compute executed/total statement counts for the Target_File only. The real Target_File on disk is never touched by this path (Requirement 10.6) — only the temp copy is written and torn down after the run, even on failure or timeout.

### Test Cache

```typescript
interface CachedResult {
  outcome: TestOutcome;
}

interface TestCache {
  get(contentHash: string): CachedResult | undefined;
  set(contentHash: string, result: CachedResult): void;
}
```

One `TestCache` instance per analysis run (created at Search start, discarded at Search end — Requirement 11.5). `Content_Hash` is a SHA-256 of the candidate Position's exact source text.

### Evaluator

```typescript
interface Metrics {
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  functionLength: number;
  duplicatedCode: number;
  unusedCode: number;
}

interface ScoredPosition {
  metrics: Metrics;
  score: number;             // baseline - weighted sum of metrics
}

interface Evaluator {
  evaluate(position: Position): ScoredPosition | { notEvaluable: true };
  scoreOfLine(finalPositionScore: number, moveCount: number): number; // applies Move_Penalty
}
```

Weights and baseline are fixed module constants (documented in the README and referenced here so Requirement 13.2's "stated in documentation" is satisfied):

```typescript
const EVALUATOR_BASELINE = 0;
const WEIGHTS = {
  cyclomaticComplexity: 1,
  maxNestingDepth: 2,
  functionLength: 0.1,
  duplicatedCode: 1,
  unusedCode: 1,
} as const;
const MOVE_PENALTY = 0.5;
```

(Exact values are tunable before implementation but are fixed constants exported from one module, satisfying "same for every Position and every run.")

### Beam Search

```typescript
interface SearchNode {
  position: Position;
  line: Candidate[];           // moves taken to reach this node from the root
  score: number;               // this position's raw score (no Move_Penalty)
}

interface ProgressEvent {
  score: number;                 // score after Move_Penalty
  line: Candidate[];
}

interface SearchResult {
  bestLine: Candidate[];         // empty if no improvement found
  allLines: SearchNode[];        // every Line explored, for the Recording
  blunders: BlunderRecord[];
}

interface BeamSearch {
  run(root: Position, depth: 3 | 4, beamWidth: number, generator: MoveGenerator, context: GeneratorContext): Promise<SearchResult>;
}
```

Implementation follows Requirement 14 directly: depth-by-depth expansion, top-`Beam_Width` retention by raw score, candidates with no Legal_Move are not expanded further, and the final Best_Line is chosen by comparing `score - Move_Penalty * line.length` across **all** explored Lines of length 0..depth, with ties broken by fewest moves then earliest-found.

### Annotator

Pure function, isolated for testability (Requirement 15):

```typescript
type Annotation = "!!" | "!" | "?!" | "??";

function annotate(
  moveScoreGain: number,     // child.score - parent.score, no Move_Penalty
  originalScoreRange: number // abs(originalScore - 0)
): Annotation;
```

### Recording Writer / Parser

```typescript
interface RecordingParser {
  parse(json: string): Recording;  // throws RecordingParseError with field/type/version detail
}

interface RecordingPrinter {
  print(recording: Recording): string; // JSON.stringify with stable key order
}
```

See Data Models for the `Recording` shape.

### Web UI Server

A small HTTP + WebSocket server (e.g. `express` + `ws`) started by the CLI. Serves the static Web UI bundle, exposes:
- `GET /api/recording` — current/partial Recording snapshot
- `WS /ws` — progress events, depth/positions-tested updates, final Recording
- `POST /api/apply` — triggers the Apply flow (Requirement 21), returns success/failure detail

### Web UI / Replay Demo (shared rendering)

Both consume a `Recording` and render: Eval Bar, Move list, Diff viewer, Metrics panel, Blunder log. Implemented as a shared TypeScript+React (or equivalent) package `@refactor-fish/ui-core` with components that take `Recording` (or slices of it) as props and contain no fetch/WebSocket logic themselves — the live app wires WebSocket updates into state and passes it down; the Replay Demo wires a `setInterval`-driven playback of `recording.progressEvents` into the same state shape.

```typescript
interface UiState {
  recording: Recording | null;
  liveScore?: number;          // live-only; falls back to recording field in replay
  selectedMoveIndex: number | null;
  connectionLost?: boolean;    // live-only
}
```

### LLM Provider

```typescript
interface LLMMoveProposal {
  title: string;
  resultingSource: string;   // full candidate file content proposed by the LLM
}

interface LLMProvider {
  proposeMoves(position: Position, maxProposals: number, timeoutMs: number): Promise<LLMMoveProposal[]>;
}
```

The request payload contains only `position.sourceText` (Requirement 9.7) — no other file content is ever assembled into the prompt.

### MCP Server (stretch goal)

```typescript
interface FindBestRefactoringLineInput {
  path: string;
}

interface FindBestRefactoringLineOutput {
  bestLine: { moveName: string; annotation: Annotation }[];
  originalMetrics: Metrics;
  finalMetrics: Metrics;
}
```

Thin wrapper around `Engine.analyze`, reusing the same preflight/analysis path, guaranteeing no filesystem writes (Requirement 25.3) because it is built on the same in-memory Engine used by the CLI's dry-run Search.

## Data Models

### Position (runtime, not persisted on its own)

```typescript
interface Position {
  sourceText: string;
  filePath: string;
}
```

### Move / Candidate record (as persisted in a Recording)

```typescript
interface MoveRecord {
  index: number;            // 1-based position in its Line
  kind: MoveKind;
  displayName: string;
  description: string;
  annotation: Annotation;
  sourceBefore: string;     // Position before this Move
  sourceAfter: string;      // Position after this Move
  metricsBefore: Metrics;
  metricsAfter: Metrics;
  scoreBefore: number;
  scoreAfter: number;
}
```

### Blunder record

```typescript
interface BlunderRecord {
  moveDescription: string;
  lineIndex: number;        // 1-based position within the Line that produced it
  failingTests: TestFailure[];
  failureReason?: "timeout" | "test execution error";
}
```

### Line record (for `allLines` in the Recording)

```typescript
interface LineRecord {
  moves: MoveRecord[];      // length 0..Search_Depth
  finalScore: number;       // after Move_Penalty
}
```

### Coverage info

```typescript
interface CoverageInfo {
  percent: number | null;   // null when unknown
  unknown: boolean;
  belowThreshold: boolean;  // percent !== null && percent < 60.0
}
```

### Search settings (persisted for reproducibility/display)

```typescript
interface SearchSettings {
  searchDepth: 3 | 4;
  beamWidth: number;
  llmEnabled: boolean;
}
```

### Progress event (persisted so Replay can play them back)

```typescript
interface ProgressEventRecord {
  score: number;             // after Move_Penalty
  line: MoveRecord[];        // the Line at the moment this event fired
  depth: number;
  positionsTested: number;
}
```

### Recording (the full JSON document — Requirement 16)

```typescript
interface Recording {
  formatVersion: 1;                     // Requirement 16.2, 16.9
  targetFileName: string;
  originalSource: string;
  originalMetrics: Metrics;
  originalScore: number;
  searchSettings: SearchSettings;
  coverage: CoverageInfo;
  allLines: LineRecord[];
  bestLine: MoveRecord[];               // empty array = "no improvement found"
  blunders: BlunderRecord[];
  progressEvents: ProgressEventRecord[];
}
```

Field order above is also the required-field check order used by the parser for Requirement 16.5 ("names the first missing field in the order listed").

**Example Recording JSON** (abbreviated):

```json
{
  "formatVersion": 1,
  "targetFileName": "messyModule.ts",
  "originalSource": "export function foo() { ... }",
  "originalMetrics": {
    "cyclomaticComplexity": 12,
    "maxNestingDepth": 4,
    "functionLength": 80,
    "duplicatedCode": 6,
    "unusedCode": 3
  },
  "originalScore": -18.4,
  "searchSettings": { "searchDepth": 4, "beamWidth": 3, "llmEnabled": false },
  "coverage": { "percent": 72.5, "unknown": false, "belowThreshold": false },
  "allLines": [
    { "moves": [], "finalScore": -18.4 },
    { "moves": [ { "index": 1, "kind": "RemoveUnused", "displayName": "Remove unused", "description": "Remove unused import 'lodash'", "annotation": "!", "sourceBefore": "...", "sourceAfter": "...", "metricsBefore": { }, "metricsAfter": { }, "scoreBefore": -18.4, "scoreAfter": -15.1 } ], "finalScore": -15.6 }
  ],
  "bestLine": [
    { "index": 1, "kind": "RemoveUnused", "displayName": "Remove unused", "description": "Remove unused import 'lodash'", "annotation": "!", "sourceBefore": "...", "sourceAfter": "...", "metricsBefore": { }, "metricsAfter": { }, "scoreBefore": -18.4, "scoreAfter": -15.1 },
    { "index": 2, "kind": "GuardClause", "displayName": "Guard clause", "description": "Convert nested if in validate() to a guard clause", "annotation": "!!", "sourceBefore": "...", "sourceAfter": "...", "metricsBefore": { }, "metricsAfter": { }, "scoreBefore": -15.1, "scoreAfter": -8.0 }
  ],
  "blunders": [
    { "moveDescription": "Inline variable 'total'", "lineIndex": 1, "failingTests": [ { "testName": "computes total correctly", "message": "expected 10 to equal 12" } ] }
  ],
  "progressEvents": [
    { "score": -15.6, "line": [ /* MoveRecord */ ], "depth": 1, "positionsTested": 4 },
    { "score": -8.5, "line": [ /* MoveRecord, MoveRecord */ ], "depth": 2, "positionsTested": 11 }
  ]
}
```

This directly satisfies Requirement 16.1 (every listed field present) and provides the Replay Demo everything it needs to reproduce the live experience without a backend (Requirement 22.3, 22.5).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The properties below were derived from the acceptance-criteria prework analysis and consolidated to remove redundancy (e.g., generation-eligibility rules and their exclusion clauses are expressed as one "generated iff predicate holds" property per Move kind; classification branches for the same decision function are expressed as one property covering all branches).

### Property 1: Extension validation

For any file path string, the CLI SHALL accept it for analysis if and only if it ends in `.ts` or `.tsx`.

**Validates: Requirements 1.4**

### Property 2: Parse-error location reporting

For any syntactically invalid TypeScript source text used as the Target_File, the parse error reported by the CLI SHALL include the file path, a line number, and a column number that correspond to a real position within the source text.

**Validates: Requirements 1.5**

### Property 3: Failing-test reporting fidelity

For any set of test results returned by the Test_Runner for the original Position, the set of failing test names printed/displayed by the CLI and Web_UI SHALL be exactly the set of test names the Test_Runner reported as failed.

**Validates: Requirements 2.5, 2.6**

### Property 4: Coverage percentage formula correctness

For any pair of non-negative integers (executedStatements, totalStatements) with executedStatements ≤ totalStatements, the computed coverage percentage SHALL equal `round((executedStatements / totalStatements) * 100, 1)` when totalStatements > 0, and the coverage SHALL be reported as unknown when totalStatements = 0.

**Validates: Requirements 3.1, 3.4, 3.5**

### Property 5: Coverage warning threshold

For any coverage percentage value from 0 to 100, the coverage warning SHALL be shown if and only if the value is strictly less than 60.0, with identical visibility and message text in the CLI and the Web_UI.

**Validates: Requirements 3.2, 3.3**

### Property 6: Remove_Unused candidate generation matches usage classification

For any Position containing an arbitrary mix of imports, variables, and functions where each declaration is independently marked as referenced-elsewhere, exported, or neither, the Move_Generator SHALL generate exactly one Remove_Unused candidate for each declaration that is neither exported nor referenced outside its own body, and SHALL generate none for any other declaration.

**Validates: Requirements 4.1, 4.3**

### Property 7: Remove_Unused application locality and validity

For any Position and any one of its Remove_Unused candidates, applying that candidate SHALL produce a resulting Position that differs from the original only in the text of the targeted declaration (or specifier), leaves every other declaration's text unchanged, and parses with zero syntax errors.

**Validates: Requirements 4.2**

### Property 8: Referenced-symbol preservation under Remove_Unused

For any Position and any Remove_Unused Move applicable to it, every symbol that is referenced anywhere in the Position before the Move is applied SHALL still be declared somewhere in the resulting Position after the Move is applied.

**Validates: Requirements 4.4, 24.3**

### Property 9: Import specifier removal granularity

For any import statement with N named specifiers (N ≥ 1) where one specifier is the Remove_Unused target, applying the Move SHALL remove only that specifier and retain the import statement when N > 1, and SHALL remove the entire import statement when N = 1.

**Validates: Requirements 4.6**

### Property 10: Inline_Variable eligibility predicate

For any `const` declaration with a single identifier binding and an initializer, embedded in a generated Position with a controlled reference count, export status, intervening side-effecting expressions, and reference-site nesting (nested function, loop, or conditionally-evaluated branch), the Move_Generator SHALL generate an Inline_Variable candidate for it if and only if: it has exactly one reference outside the declaration, it is not exported, no side-effecting expression or reassignment of a variable the initializer reads occurs on the execution path between declaration and reference, and if the reference is inside a nested function/loop/conditional branch not containing the declaration then the initializer contains no side-effecting expression.

**Validates: Requirements 5.1, 5.3, 5.4, 5.5**

### Property 11: Inline_Variable substitution correctness

For any Position and any eligible Inline_Variable candidate, applying it SHALL replace the single reference with the initializer expression (parenthesized when required to preserve the initializer's operator precedence in its new context), expand a shorthand property reference `{ x }` to `{ x: <initializer> }` where applicable, remove only the inlined declarator from its declaration statement, and produce a Position that parses as valid TypeScript.

**Validates: Requirements 5.2**

### Property 12: Guard_Clause eligibility predicate

For any function/method/arrow function body generated with a controlled trailing-statement shape after a candidate `if` (nothing, a single `return`, or some other statement) and a controlled set of identifiers already declared in the enclosing scope, the Move_Generator SHALL generate a Guard_Clause candidate for an eligible `if`-without-`else` if and only if it is followed by nothing or by exactly one `return` statement (and, when followed by nothing, the function's return type is void or includes undefined), and unwrapping its body would introduce no `let`/`const`/`class`/function name collision with the enclosing scope.

**Validates: Requirements 6.1, 6.5, 6.6**

### Property 13: Guard_Clause transform shape correctness

For any Position and any eligible Guard_Clause candidate, applying it SHALL produce an `if` statement whose condition is the logical negation of the original condition and whose body is a single early return — a bare `return;` when the function's return type is void, and otherwise the expression of the following `return` statement, or `return undefined;` when none follows and `undefined` is part of the return type — followed by the original `if` body's statements unwrapped to the replaced `if` statement's nesting level.

**Validates: Requirements 6.2, 6.3, 6.4**

### Property 14: Simplify_Boolean rewrite-iff-exact-boolean-type with site locality

For any Position containing one or more independently generated rewrite sites of the forms `x === true`, `!!x` in a boolean context, and `if (c) return true; else return false;`, each with an independently controlled static type (exactly `boolean`, a union containing a non-boolean member, `any`, or `unknown`), the Move_Generator SHALL generate a Simplify_Boolean candidate for a site if and only if the relevant operand's static type is exactly `boolean`, and applying any single candidate SHALL change only its own site's source text, leaving every other site and the rest of the file unchanged.

**Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

### Property 15: Extract_Function eligibility predicate

For any function body generated with a contiguous statement sequence of controlled length and a controlled mix of free identifiers (resolvable to the enclosing scope or declared inside the sequence), early returns, break/continue targets, and `await` usage inside an async or non-async enclosing function, the Move_Generator SHALL generate an Extract_Function candidate for the sequence if and only if it has at least 5 statements directly in the block, every free identifier it references resolves to either an enclosing-scope variable or a declaration inside the sequence, it contains no `return` other than as its final statement, no `break`/`continue` targets a loop or label outside the sequence, and it contains no `await` that would require the extracted function to be async when the enclosing function is not async.

**Validates: Requirements 8.1, 8.5**

### Property 16: Extract_Function call-site wiring correctness

For any Position and any eligible Extract_Function candidate, applying it SHALL create a new function with exactly one parameter per distinct outer variable the sequence reads, ordered by first read, and SHALL replace the sequence with a call passing each of those variables as an argument in the same order.

**Validates: Requirements 8.2**

### Property 17: Extract_Function value propagation preservation

For any Position and any eligible Extract_Function candidate where the sequence assigns to one or more outer variables or ends in a value-yielding `return`, applying the Move SHALL cause each such outer variable to hold, immediately after the call site, the same value it would have held had the original sequence executed in place (verified by executing both the pre- and post-extraction Position against an interpreter/test harness with equivalent instrumented inputs).

**Validates: Requirements 8.3**

### Property 18: Extract_Function name uniqueness

For any Position and any eligible Extract_Function candidate, the generated function name SHALL differ from every identifier declared or referenced in the scope chain at the extraction point and from every identifier inside the extracted block, and when the base name collides, the name produced SHALL be the base name with the lowest integer suffix starting at 2 that is not already taken.

**Validates: Requirements 8.4**

### Property 19: LLM candidate pipeline parity

For any syntactically valid proposal returned by a mocked LLM_Provider, the Engine SHALL subject the resulting Position to the same test execution, scoring, and Line-eligibility rules it applies to a Deterministic_Move's resulting Position, with no distinguishing code path based on move origin.

**Validates: Requirements 9.2**

### Property 20: LLM invalid-proposal discarding

For any proposal returned by a mocked LLM_Provider that does not parse as valid TypeScript, the Engine SHALL discard it, add a discard-log entry containing the proposal and the parse-failure reason, and continue the Search using the remaining proposals.

**Validates: Requirements 9.3**

### Property 21: LLM no-op proposal discarding

For any proposal returned by a mocked LLM_Provider that is empty or whose resulting source text is identical to the Position being expanded, the Engine SHALL discard it and add a discard-log entry stating that the proposal made no change.

**Validates: Requirements 9.8**

### Property 22: TestOutcome classification

For any TestOutcome value (passed; failed with N≥1 failing tests; error/unrunnable; timeout), the Engine SHALL classify the corresponding Move as a Legal_Move if and only if the outcome is "passed" with at least one test executed, and SHALL otherwise classify it as a Blunder annotated `??`, storing the Move description together with the failing test names and messages, or the failure reason ("timeout" or "test execution error") as appropriate.

**Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.8**

### Property 23: Target_File on-disk immutability across Test_Runner outcomes

For any candidate Position and any simulated Test_Runner outcome including a crash or a timeout, the bytes of the real Target_File on disk SHALL be identical before and after the Test_Runner's run.

**Validates: Requirements 10.6**

### Property 24: Accepted-moves-pass invariant

For any completed analysis, every Position in every Line returned by the Engine, including intermediate Positions and the final Position of the Best_Line, SHALL have passed the Relevant_Test_File.

**Validates: Requirements 10.9, 24.4**

### Property 25: Test_Cache correctness

For any sequence of candidate Positions presented to the Engine, including repeats and same-depth duplicates with equal Content_Hash, the Test_Runner SHALL be invoked at most once per distinct Content_Hash, every subsequent lookup for that hash SHALL return a result equal to what the Test_Runner produced (pass/fail, failing names and messages, or timeout reason), and the resulting Move classification SHALL be identical whether the result came from the cache or a fresh run.

**Validates: Requirements 11.2, 11.3, 11.4, 11.6**

### Property 26: Deterministic_Move double-apply stability

For at least 100 generated Positions and each of the five Deterministic_Move kinds (Remove_Unused, Inline_Variable, Guard_Clause, Simplify_Boolean, Extract_Function), applying the same Move to the same Position twice, independently, SHALL yield byte-identical resulting source text both times.

**Validates: Requirements 12.1, 12.3, 24.1**

### Property 27: Move_Generator order stability

For any Position, invoking the Move_Generator on it at least 100 times SHALL return the candidate list in the same order every time.

**Validates: Requirements 12.2**

### Property 28: Comment preservation across Moves

For any Position containing comments attached to retained statements in varying positions (leading, trailing, inline) and any Move applicable to it, applying the Move SHALL preserve each such comment's text, its position relative to its statement, and its order relative to other comments.

**Validates: Requirements 12.4**

### Property 29: Failed apply never mutates the input Position

For any Move and any Position on which that Move's `apply()` reports `ok: false` (including Remove_Unused, Extract_Function, or any other Move forced into an unproducible edit), the input Position's source text SHALL be unchanged and an error describing the rejection reason SHALL be returned.

**Validates: Requirements 4.5, 8.6, 12.5**

### Property 30: Metrics per-function computation and nesting exclusion

For any generated set of nested functions, methods, and arrow functions with known per-function construct counts, the Evaluator SHALL compute each of the five Metrics per function such that an outer function's measurement excludes the body of any function nested inside it, and the Target_File's total for each Metric SHALL equal the sum of that Metric across all functions.

**Validates: Requirements 13.1**

### Property 31: Score is a fixed, monotonic affine function of Metrics

For any two Metrics objects A and B where every field of A is less than or equal to the corresponding field of B, the Score computed from A SHALL be greater than or equal to the Score computed from B, and the Score formula's weights and baseline SHALL be the same constants for every input.

**Validates: Requirements 13.2**

### Property 32: Cyclomatic complexity formula correctness

For any function generated with a controlled count of `if` statements, loops, non-default `case` clauses, `catch` clauses, ternaries, and `&&`/`||`/`??` operators, the computed cyclomatic complexity SHALL equal 1 plus the sum of those counts.

**Validates: Requirements 13.4**

### Property 33: Maximum nesting depth formula correctness

For any function generated with a controlled arrangement of nested `if`/`for`/`for...in`/`for...of`/`while`/`do...while`/`switch`/`try` constructs, the computed maximum nesting depth SHALL equal the largest number of such constructs enclosing any single statement, and SHALL equal 0 when the function contains none.

**Validates: Requirements 13.5**

### Property 34: Function length formula correctness

For any function spanning a controlled range of source lines, the computed function length SHALL equal (lastLine − firstLine + 1).

**Validates: Requirements 13.6**

### Property 35: Duplicated code formula correctness

For any Target_File constructed with a controlled number of occurrences of a whitespace-normalized-identical block of at least 3 consecutive statements, placed without overlap, the computed duplicated-code count SHALL equal the total number of statements across every occurrence after the first.

**Validates: Requirements 13.7**

### Property 36: Unused code count matches declaration classification

For any Position, the Evaluator's unused-code count SHALL equal the number of declarations the Move_Generator's Remove_Unused classifier (Property 6) marks as neither exported nor referenced outside their own body.

**Validates: Requirements 13.8**

### Property 37: Line score arithmetic

For any final Position score S and any Line length N ≥ 0, the Line's Score SHALL equal S − N × Move_Penalty, with no deduction when N = 0.

**Validates: Requirements 13.9**

### Property 38: Evaluation determinism

For any Position, evaluating it repeatedly SHALL return an identical Score every time, regardless of call count, order, or elapsed time between calls.

**Validates: Requirements 13.10**

### Property 39: Beam selection correctness

For any generated tree of mocked Positions, Legal_Move candidates, and scores across multiple depths, the Search SHALL, at each depth, expand only Positions kept from the previous round that have at least one Legal_Move, retain at most Beam_Width of the resulting Positions ranked by score (all of them if fewer than Beam_Width exist), and never expand a kept Position with no Legal_Move.

**Validates: Requirements 14.2**

### Property 40: Depth-option validation

For any value supplied as the depth option (integers, non-integers, strings, out-of-range numbers), the CLI SHALL accept it as the Search_Depth if and only if it is exactly the integer 3 or the integer 4.

**Validates: Requirements 14.4, 14.5**

### Property 41: Best_Line selection correctness

For any generated set of Lines of lengths 0 through Search_Depth with assigned scores (including deliberately tied scores and the case where no Line exceeds the root's score), the Engine SHALL select as the Best_Line the Line with the highest Score after the Move_Penalty, breaking ties by fewest Moves and then by earliest-found order, and SHALL select the empty Line when no Line's Score after the Move_Penalty strictly exceeds the original Position's Score.

**Validates: Requirements 14.6, 14.7**

### Property 42: Non-regression of the Best_Line

For any completed analysis, the Score of the Best_Line after the Move_Penalty SHALL be greater than or equal to the Score of the original Position, and SHALL equal it exactly when the Best_Line is empty.

**Validates: Requirements 14.8, 24.2**

### Property 43: Progress event emission correctness

For any generated sequence of candidate scores processed during a Search, a progress event SHALL be emitted exactly when a Position's Score after the Move_Penalty is strictly higher than every previously found Position's Score, and no progress event SHALL be emitted for the root.

**Validates: Requirements 14.9**

### Property 44: Annotation function correctness

For any combination of Legal_Move/Blunder status, Score gain, and original-Position Score range (including a range of exactly 0), the Engine SHALL annotate the Move `??` if it is a Blunder; otherwise `!!` when the gain is at least 15% of the range, `!` when at least 5% and below 15%, and `?!` when below 5% (including zero, negative, or an undefined ratio because the range is 0).

**Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6**

### Property 45: Move line formatting

For any 1-based index, Move display name, and Annotation, the formatted line SHALL equal exactly `"<n>. <Move name> <Annotation>"`.

**Validates: Requirements 15.7**

### Property 46: Recording parser rejects malformed JSON

For any string that is not valid JSON, the Recording parser SHALL reject it and return an error indicating the document is malformed JSON, producing no Recording.

**Validates: Requirements 16.4**

### Property 47: Recording parser reports first missing required field

For any valid Recording JSON document with exactly one required field removed, the Recording parser SHALL reject it and name that field as missing; for documents with multiple fields removed, it SHALL name the one that occurs first in the field order of Requirement 16 criterion 1.

**Validates: Requirements 16.5**

### Property 48: Recording parser reports wrong-type fields

For any valid Recording JSON document with exactly one required field's value replaced by a value of an incompatible type, the Recording parser SHALL reject it and name that field together with its expected type.

**Validates: Requirements 16.6**

### Property 49: Recording round-trip

For at least 100 generated valid Recordings, including ones with zero Blunders and an empty Best_Line, parsing, then printing, then parsing again SHALL produce a Recording equal in every field to the first parsed Recording.

**Validates: Requirements 16.7, 16.8, 24.5**

### Property 50: Recording parser rejects unsupported versions

For any integer format-version value outside the set of versions the parser supports, the parser SHALL reject the document and report the version found together with the list of supported versions.

**Validates: Requirements 16.9**

### Property 51: Eval bar scale clamping and rounding

For any pair (score, originalScore) with originalScore < 0, the Eval Bar's fill fraction SHALL be the result of clamping `score` to the range [originalScore, 0] before mapping to a fill percentage, and the displayed label SHALL equal `score` rounded to 1 decimal place.

**Validates: Requirements 17.3**

### Property 52: Move navigation index logic

For any Best_Line length L ≥ 0 and any current selection index within range, "previous" SHALL select `index - 1` and be disabled only when `index = 0`, "next" SHALL select `index + 1` and be disabled only when `index = L - 1`, and "jump to end" SHALL select `L - 1`; when `L = 0`, all three controls SHALL be disabled and no selection SHALL be made.

**Validates: Requirements 18.3, 18.4, 18.5, 18.6, 18.7, 18.8**

### Property 53: No-textual-change detection

For any pair of before/after source strings, the Web_UI SHALL display the "no textual change" message if and only if the two strings are exactly equal.

**Validates: Requirements 18.9**

### Property 54: Metrics change formatting and mark derivation

For any pair of integers (originalValue, selectedValue), the displayed change SHALL equal `selectedValue - originalValue` formatted with an explicit sign, or `"0"` when they are equal, and the mark SHALL be "improved" when the change is negative, "worsened" when positive, and "unchanged" when zero.

**Validates: Requirements 19.4, 19.5**

### Property 55: Missing-metrics placeholder handling

For any Metrics object with an arbitrary subset of its five fields set to missing/null for the original or selected Position, the Metrics panel SHALL display "unavailable" for exactly those missing fields' values and changes, and SHALL display the real value for every field that is present.

**Validates: Requirements 19.6**

### Property 56: Blunder log empty-message indicator

For any generated list of Blunders whose failing tests independently have a message or no message, the Blunder log SHALL show the empty-message indicator if and only if that failing test's message is absent, and SHALL always show the test name regardless.

**Validates: Requirements 20.3**

### Property 57: No writes outside the designated temp area during Search

For any Search run driven by mocked Moves and Test_Runner outcomes (including simulated failures), no filesystem write or delete call SHALL target the real Target_File path or any path outside the run's designated temporary directory, from the start of the Search until it ends or is cancelled. This property applies identically whether the Search is driven by the CLI or by the MCP server entry point.

**Validates: Requirements 21.1, 25.3**

### Property 58: Apply content selection and move count

For any Best_Line of length L ≥ 1 and any selected index 0 ≤ i < L, "Apply up to selected move" SHALL write the `sourceAfter` text of the Move at index i and report `i + 1` as the number of Moves applied, and "Apply best line" SHALL write the `sourceAfter` text of the Move at index `L - 1` and report `L` as the number of Moves applied.

**Validates: Requirements 21.2, 21.3, 21.6**

### Property 59: Apply disk-freshness guard

For any pair (diskContent, originalPositionContent), the apply action SHALL proceed to run tests and potentially write if and only if the two are byte-for-byte equal; otherwise it SHALL refuse to write, leave the Target_File unchanged, and not invoke the Test_Runner.

**Validates: Requirements 21.5**

### Property 60: Apply test-outcome gating

For any TestOutcome produced for the Position to be written (passed, failed, error, or timeout), the apply action SHALL write to the Target_File if and only if the outcome is "passed", and SHALL otherwise leave the Target_File unchanged and display a message identifying the outcome (tests failed, could not run, or timed out).

**Validates: Requirements 21.7, 21.8**

### Property 61: MCP invalid-path rejection

For any path string that is missing, empty, non-existent, or lacks a `.ts`/`.tsx` extension, the MCP server's `find_best_refactoring_line` tool SHALL return an error result naming the path and the specific reason, and SHALL NOT start the Engine.

**Validates: Requirements 25.5**

## Error Handling

Error handling follows one consistent shape across the system: every operation that can fail returns a discriminated result (`{ ok: true, ... } | { ok: false, error: {...} }`) rather than throwing across component boundaries, except at the outermost CLI/Web UI/MCP layers, which translate a failed result into the user-facing message, exit code, or error payload required by the relevant acceptance criteria.

### CLI-level errors (Requirement 1, 2, 14)

| Condition | Handling |
|---|---|
| File does not exist | Print error naming the path to stderr, exit non-zero, nothing started |
| Wrong extension | Print "only TypeScript files are supported" to stderr, exit non-zero |
| Parse failure | Print path + line + column to stderr, exit non-zero, Web UI not started |
| No file argument | Print usage message to stderr, exit non-zero |
| Invalid depth option | Print accepted-range error to stderr, exit non-zero, Search not started |
| Default port busy | Silently retry on another free port, print chosen URL |
| Browser fails to open | Print URL + warning to stdout, keep server running |
| No Relevant_Test_File | Print "needs tests" message, exit non-zero, Search not run |
| Original Position fails tests | Print failing test names, exit non-zero, Search not run |
| Tests unrunnable | Print "tests could not be run" message, exit non-zero |

All of the above are mutually exclusive, ordered checks performed by the CLI/Engine preflight pipeline; the first failing check short-circuits the rest, so the Engine and Web UI are never partially started.

### AST Editor errors (Requirement 4, 5, 6, 7, 8, 12)

Every `Candidate.apply()` call is wrapped so that:
1. ts-morph operates on a throwaway in-memory `Project`, never the shared Position object.
2. If the edit throws (ts-morph internal error) or the resulting source fails to re-parse (checked via `getPreEmitDiagnostics`-free syntactic re-parse), `apply()` returns `{ ok: false, error: { reason } }` and the caller discards the candidate — the original Position is provably untouched because it was never passed into the mutated `Project`.
3. This uniform contract is what Property 29 verifies, and it is why Requirements 4.5, 8.6, and 12.5 are implemented as one code path rather than three.

### Test execution errors (Requirement 10, 11)

- **Timeout**: the Test Runner races the Vitest run against a 60-second timer (candidate tests) or 300-second timer (apply-time re-test). On expiry, the in-flight Vitest process is killed, the candidate is classified `Blunder`/apply is refused with failure reason `"timeout"`, and the temp directory is cleaned up in a `finally` block so partial state never leaks.
- **Unrunnable** (syntax error, missing dependency, zero tests collected): detected from Vitest's own run summary; classified as `Blunder` with reason `"test execution error"`, with the raw error message preserved for the Blunder log.
- **Target_File integrity**: because candidate execution always happens in a temp copy, a crash or non-zero exit from the Vitest child process cannot touch the real Target_File; this is enforced structurally (Property 23) rather than by a try/catch around the real file.

### LLM provider errors (Requirement 9)

| Condition | Handling |
|---|---|
| Provider errors or doesn't respond in 30s | No retry; Search continues with Deterministic_Moves only for that Position; Recording gets an entry noting the Position and whether it was an error or timeout |
| Proposal fails to parse | Discarded; discard log gets the proposal + parse failure reason; remaining proposals still considered |
| Proposal is empty or a no-op | Discarded; discard log gets a "no change" entry |
| Proposal's resulting Position fails tests | Classified as a normal Blunder via the shared TestOutcome classification (Property 22); excluded from every Line; discard log gets a "tests failed" entry |

The LLM path never gets a privileged retry or a relaxed legality check — any failure mode simply removes that one candidate from consideration.

### Recording parse errors (Requirement 16)

The parser validates in a fixed order: (1) JSON syntax, (2) presence of every required field in the field order from the Data Models section, (3) type of every required field, (4) format version membership. Each stage either returns a structured `RecordingParseError` (`{ kind: "malformed-json" } | { kind: "missing-field", field } | { kind: "wrong-type", field, expectedType } | { kind: "unsupported-version", found, supported }`) and stops, or proceeds to the next stage. No partial `Recording` object is ever returned on failure.

### Apply-time errors (Requirement 21)

Apply is a strict pipeline: **freshness check → test re-run → write**, each gated on the previous step succeeding:

1. If the on-disk Target_File differs byte-for-byte from the original Position, refuse immediately with a "file changed since analysis" message; no test run, no write.
2. If the freshness check passes, re-run the Relevant_Test_File against the Position to be written (final independent legality check against current test state, since both tests and source could have been touched between analysis start and apply time only via other tools — refactor-fish itself made no writes). Any non-"passed" outcome (failed, unrunnable, timeout) blocks the write and surfaces the specific reason.
3. If the write itself fails (I/O error, permissions), the Target_File is left with its original content (the write targets a temp file first, then an atomic rename, so a failed write cannot leave a half-written file in place) and a "write failed" message is shown.

### MCP server errors (Requirement 25)

The MCP tool validates its one input (path existence, extension) before touching the Engine; validation failures return an error result with no Engine invocation. Engine-level errors are forwarded verbatim as the MCP error result's message, with no partial Best_Line ever included, and the same in-memory/temp-copy discipline as the CLI path guarantees the Target_File and every other project file stay byte-identical regardless of outcome.

## Testing Strategy

### Dual approach

- **Unit tests** cover concrete examples, fixed scenarios, and integration/wiring points: CLI argument parsing scenarios, Sample Project smoke checks, Replay Demo static-asset behavior, disconnect/timing UI behavior, and the handful of fault-injection cases (slow test run, I/O write failure) that don't benefit from randomized iteration.
- **Property tests** cover the 61 correctness properties listed above, each implemented as a single property-based test per the Property Creation Process, run with **fast-check** (chosen because the stack is TypeScript/Vitest and fast-check integrates directly as a Vitest dependency with no separate runner).

### Property-based testing setup

- Library: **fast-check**, invoked via `fc.assert(fc.property(...), { numRuns: 100 })` (or higher where a requirement names a specific minimum, e.g. Requirement 24.1's "at least 100 generated Positions" or 24.2's "at least 20 generated analyses").
- Every property test is tagged with a comment in the exact format:
  `// Feature: refactor-fish, Property {number}: {property text}`
- Custom arbitraries are built for the recurring generated shapes: `arbitraryPosition()` (valid small TypeScript source with controllable unused declarations, single-use consts, nested ifs, boolean expressions, and 5+-statement blocks), `arbitraryMetrics()`, `arbitraryRecording()`, `arbitraryTestOutcome()`, and `arbitraryLine()`. These are composed via `fc.record`, `fc.oneof`, and recursive `fc.letrec` where source structure must nest (e.g. nested functions for Property 30, nested control structures for Property 33).
- Seed reproducibility (Requirement 24.7) and counterexample reporting (Requirement 24.6) are satisfied by fast-check's built-in behavior: CI captures the `seed` fast-check prints on failure, and local re-runs pass `{ seed, path }` back into `fc.assert` to reproduce exactly. No custom seeding mechanism is built.
- Properties whose subject is "my code's logic against mocked externals" (LLM provider, Vitest Test Runner, filesystem) use fast-check together with a hand-written mock/fake for the external dependency (`FakeLLMProvider`, `FakeTestRunner`, an in-memory `fs` spy) so iteration stays cheap — no property test performs a real Vitest child-process run or a real LLM call.

### What is deliberately NOT property-tested

The following requirement areas are UI rendering, infrastructure/timing, or fixed one-off artifacts, and are covered by unit/integration/smoke tests instead, per the design's PBT-applicability assessment:

- CLI process startup timing, port selection, browser launching (Requirement 1.1, 1.2, 1.6, 1.7) — OS/process integration.
- Web UI/Replay Demo live update timing (500ms/200ms/5s/3s windows in Requirements 17, 18, 19, 22) — timing-dependent UI behavior, tested with fake timers in component tests.
- The bundled Sample Project and its bundled Recording (Requirement 23) — fixed artifacts, verified once by smoke tests (tests pass on the unmodified file, at least one opportunity per Deterministic_Move exists, the bundled Recording parses and has a Best_Line ≥ 3 moves and ≥ 1 Blunder).
- Visual/accessibility aspects ("not distinguishable by color alone", calm aesthetic-type requirements) — not present in this spec, but any such requirement would be a manual/snapshot check, not PBT.
- MCP tool schema shape and simple wiring pass-throughs (25.1, 25.2, 25.4, 25.6) — example tests against a running MCP tool invocation.

### Example/unit test coverage (non-exhaustive, representative)

- CLI: missing file, wrong extension, no argument, invalid depth value, port-in-use fallback, browser-open failure message.
- Preflight: no Relevant_Test_File found, original Position fails tests, tests unrunnable.
- Test Runner: a run that exceeds 60s is killed and classified `timeout`; a run with a missing dependency is classified `test execution error`.
- Test Cache: fresh cache per run, no cross-run leakage (instantiate two Engines against the same Position, confirm independent cache state).
- LLM: no provider configured sends zero requests; request payload contains only Target_File content.
- Recording: constructing a real `Recording` from a real (small) analysis contains every field from Requirement 16.1.
- Web UI/Replay Demo: empty Best_Line shows "no improvement"/"no refactoring found" messaging and disables controls; disconnect shows a message within the UI's fake-timer-driven test and retains last-known values; Blunder log shows "no moves broke tests" when empty.
- Apply: reject leaves the file untouched; a simulated write I/O error leaves original content and shows "write failed".
- Sample Project / Replay Demo: smoke test that the bundled Recording loads, parses, and renders without making any network request other than loading its own static assets.

### Test organization

- `packages/engine`: Move Generator, AST Editor, Test Runner, Test Cache, Evaluator, Beam Search, Annotator, Recording parser/printer — the bulk of the property tests live here, colocated with the units they test (e.g. `remove-unused.test.ts`, `recording.property.test.ts`).
- `packages/ui-core`: shared rendering/view-model logic (navigation index math, metrics formatting, eval bar scale, blunder log view-model) consumed by both the live Web UI and the Replay Demo — property tests here cover Properties 51–56.
- `packages/cli`: argument parsing and process orchestration — unit/integration tests.
- `packages/mcp` (stretch): MCP tool wiring — unit/integration tests plus reuse of the Property 57 filesystem-spy harness.
- `sample-project/`: the bundled messy file, its Vitest test file, and the bundled `recording.json` — smoke-tested once in CI.
