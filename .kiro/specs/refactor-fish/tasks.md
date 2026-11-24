# Implementation Plan: Refactor-fish

## Overview

Implementation language: **TypeScript** (Node, Vitest, ts-morph, fast-check), as specified in the design. Work is organized as an npm-workspaces monorepo: `packages/engine`, `packages/ui-core`, `packages/cli`, `packages/web` (live UI and Replay Demo), `packages/mcp` (stretch), and `sample-project/`.

The plan builds bottom-up: shared types and the AST editor, then each Deterministic_Move, the Evaluator, the test runner and cache, the legality pipeline, LLM moves, beam search, the Engine, Apply, shared UI view-models, CLI and server, the web apps, the sample project and bundled Recording, and finally the MCP server. Each property test goes in its own file named after its property number (for example `remove-unused.p6.property.test.ts`) and carries the tag comment `// Feature: refactor-fish, Property {n}: {text}`. Property tests use `fc.assert(fc.property(...), { numRuns: 100 })` (or the higher minimum a requirement names) with fakes (`FakeLLMProvider`, `FakeTestRunner`, an fs spy) so no property test spawns a real Vitest run or LLM call.

## Tasks

- [x] 1. Set up monorepo and test tooling
  - [x] 1.1 Scaffold workspaces and build configuration
    - Create root `package.json` with npm workspaces, shared `tsconfig.base.json`, and Vitest config
    - Create `packages/engine`, `packages/ui-core`, `packages/cli`, `packages/web`, `packages/mcp` with their own `package.json` and `tsconfig.json`
    - Add dependencies: `ts-morph`, `vitest`, `@vitest/coverage-v8`, `fast-check`; the CLI package declares the `refactor-fish` bin entry
    - _Requirements: 1.1, 24.6, 24.7_

  - [x] 1.2 Create shared property-test helpers and arbitraries
    - In `packages/engine/test-utils`, add `arbitraryPosition()`, `arbitraryMetrics()`, `arbitraryRecording()`, `arbitraryTestOutcome()`, `arbitraryLine()`
    - Add `FakeTestRunner`, `FakeLLMProvider`, and an in-memory fs spy
    - Document how to re-run with `{ seed, path }` for reproduction (fast-check built-in behavior)
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7_

- [x] 2. Implement core types and the AST Editor
  - [x] 2.1 Define core types and content hashing
    - In `packages/engine/src/types.ts`, define `Position`, `Candidate`, `ApplyResult`, `MoveKind`, `MoveGenerator`, `GeneratorContext`, `TestOutcome`, `TestFailure`, `Metrics`, `Annotation`, `DiscardLogEntry`
    - Implement `contentHash(sourceText)` using SHA-256
    - _Requirements: 11.1, 12.1_

  - [x] 2.2 Implement the AST Editor wrapper
    - Implement `AstEditor.load(position)` creating a fresh in-memory ts-morph `Project` per call, exposing `getSourceFile()`, `getTypeChecker()`, `commit()`
    - Implement a syntactic re-parse check and a shared `safeApply` wrapper returning `{ ok: false, error: { reason } }` on edit failure or unparseable output, never mutating the input Position
    - _Requirements: 4.2, 4.5, 8.6, 12.1, 12.4, 12.5_

- [x] 3. Implement the Recording format, parser, and printer
  - [x] 3.1 Implement Recording types, parser, and printer
    - Define `Recording`, `MoveRecord`, `BlunderRecord`, `LineRecord`, `CoverageInfo`, `SearchSettings`, `ProgressEventRecord`
    - Implement `RecordingParser.parse` validating in order: JSON syntax, missing field (in design field order), wrong type, supported version; return structured `RecordingParseError`
    - Implement `RecordingPrinter.print` with stable key order and `formatVersion: 1`
    - _Requirements: 16.1, 16.2, 16.4, 16.5, 16.6, 16.7, 16.9_

  - [x] 3.2 Write property test for malformed JSON rejection
    - **Property 46: Recording parser rejects malformed JSON**
    - **Validates: Requirements 16.4**

  - [x] 3.3 Write property test for first-missing-field reporting
    - **Property 47: Recording parser reports first missing required field**
    - **Validates: Requirements 16.5**

  - [x] 3.4 Write property test for wrong-type field reporting
    - **Property 48: Recording parser reports wrong-type fields**
    - **Validates: Requirements 16.6**

  - [x] 3.5 Write property test for Recording round-trip
    - **Property 49: Recording round-trip**
    - Use at least 100 runs, including zero Blunders and an empty Best_Line
    - **Validates: Requirements 16.7, 16.8, 24.5**

  - [x] 3.6 Write property test for unsupported format versions
    - **Property 50: Recording parser rejects unsupported versions**
    - **Validates: Requirements 16.9**

- [ ] 4. Implement Remove_Unused
  - [x] 4.1 Implement the unused-declaration classifier and Remove_Unused generator
    - Implement a shared classifier: a declaration is unused iff it is not exported and has no reference outside its own body
    - Generate exactly one candidate per unused import, variable, or function, in source order
    - Implement `apply` removing only the target declaration; remove a single import specifier when the import has more than one, the whole import when it has one
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6_

  - [x] 4.2 Write property test for candidate generation
    - **Property 6: Remove_Unused candidate generation matches usage classification**
    - **Validates: Requirements 4.1, 4.3**

  - [x] 4.3 Write property test for application locality and validity
    - **Property 7: Remove_Unused application locality and validity**
    - **Validates: Requirements 4.2**

  - [x] 4.4 Write property test for referenced-symbol preservation
    - **Property 8: Referenced-symbol preservation under Remove_Unused**
    - Use at least 100 runs
    - **Validates: Requirements 4.4, 24.3**

  - [~] 4.5 Write property test for import specifier granularity
    - **Property 9: Import specifier removal granularity**
    - **Validates: Requirements 4.6**

- [ ] 5. Implement Inline_Variable
  - [x] 5.1 Implement the Inline_Variable generator and apply
    - Eligibility: single-identifier `const` with initializer, exactly one reference, not exported, no side-effecting expression or reassignment of read variables on the path, and no side-effecting initializer when the reference is in a nested function, loop, or conditional branch
    - Apply: substitute with parentheses where precedence requires, expand shorthand `{ x }` to `{ x: <init> }`, delete only the inlined declarator
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [~] 5.2 Write property test for the eligibility predicate
    - **Property 10: Inline_Variable eligibility predicate**
    - **Validates: Requirements 5.1, 5.3, 5.4, 5.5**

  - [~] 5.3 Write property test for substitution correctness
    - **Property 11: Inline_Variable substitution correctness**
    - **Validates: Requirements 5.2**

- [ ] 6. Implement Guard_Clause
  - [x] 6.1 Implement the Guard_Clause generator and apply
    - Eligibility: `if` without `else`, followed by nothing or a single `return`; no candidate when followed by nothing in a non-void function whose type excludes `undefined`; no candidate on name collision when unwrapping
    - Apply: negated condition with early `return;` (void), the following return's expression, or `return undefined;`, then unwrapped body statements
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [~] 6.2 Write property test for the eligibility predicate
    - **Property 12: Guard_Clause eligibility predicate**
    - **Validates: Requirements 6.1, 6.5, 6.6**

  - [~] 6.3 Write property test for transform shape correctness
    - **Property 13: Guard_Clause transform shape correctness**
    - **Validates: Requirements 6.2, 6.3, 6.4**

- [ ] 7. Implement Simplify_Boolean
  - [x] 7.1 Implement the Simplify_Boolean generator and apply
    - Cover `x === true`, `!!x` in boolean contexts, and `if (c) return true; else return false;` (with or without braces)
    - Use the type checker; generate a candidate only when the operand type is exactly `boolean` (exclude `any`, `unknown`, unions with non-boolean members)
    - One candidate per rewrite site; applying one changes only its site
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [~] 7.2 Write property test for exact-boolean rewriting and site locality
    - **Property 14: Simplify_Boolean rewrite-iff-exact-boolean-type with site locality**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

- [ ] 8. Implement Extract_Function
  - [x] 8.1 Implement the Extract_Function generator and apply
    - Eligibility: at least 5 contiguous statements directly in one block; free identifiers resolvable; no non-final `return`; no `break`/`continue` targeting outside; no `await` when the enclosing function is not async
    - Apply: new function with one parameter per outer variable read (order of first read), call passing them, return and assign modified outer variables and value-yielding returns
    - Name selection: base name with lowest integer suffix from 2 that avoids every identifier in the scope chain and the block
    - Reject and leave the Position unchanged when the result does not parse
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [~] 8.2 Write property test for the eligibility predicate
    - **Property 15: Extract_Function eligibility predicate**
    - **Validates: Requirements 8.1, 8.5**

  - [~] 8.3 Write property test for call-site wiring
    - **Property 16: Extract_Function call-site wiring correctness**
    - **Validates: Requirements 8.2**

  - [~] 8.4 Write property test for value propagation preservation
    - **Property 17: Extract_Function value propagation preservation**
    - Execute pre- and post-extraction code in a harness and compare outer variable values
    - **Validates: Requirements 8.3**

  - [~] 8.5 Write property test for name uniqueness
    - **Property 18: Extract_Function name uniqueness**
    - **Validates: Requirements 8.4**

- [ ] 9. Assemble the Deterministic Move Generator
  - [x] 9.1 Implement `DeterministicMoveGenerator`
    - Concatenate sub-generators in catalog order (Remove_Unused, Inline_Variable, Guard_Clause, Simplify_Boolean, Extract_Function), each in source order by node start position
    - Ensure every `apply` goes through the AST Editor `safeApply` wrapper
    - _Requirements: 12.1, 12.2, 12.5_

  - [~] 9.2 Write property test for double-apply stability
    - **Property 26: Deterministic_Move double-apply stability**
    - At least 100 generated Positions per Move kind
    - **Validates: Requirements 12.1, 12.3, 24.1**

  - [~] 9.3 Write property test for generator order stability
    - **Property 27: Move_Generator order stability**
    - Invoke at least 100 times per Position
    - **Validates: Requirements 12.2**

  - [~] 9.4 Write property test for comment preservation
    - **Property 28: Comment preservation across Moves**
    - **Validates: Requirements 12.4**

  - [~] 9.5 Write property test for failed apply leaving the Position unchanged
    - **Property 29: Failed apply never mutates the input Position**
    - **Validates: Requirements 4.5, 8.6, 12.5**

- [~] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement the Evaluator
  - [x] 11.1 Implement metric computation
    - Per function (including nested functions, methods, arrow functions), excluding bodies of nested functions: cyclomatic complexity, max nesting depth, function length (inclusive line span)
    - Whole-file duplicated code (blocks of at least 3 whitespace-normalized identical statements, count statements in every occurrence after the first) and unused code (reuse the Task 4.1 classifier)
    - Sum each Metric across all functions
    - _Requirements: 13.1, 13.4, 13.5, 13.6, 13.7, 13.8_

  - [~] 11.2 Implement scoring, Line scoring, and not-evaluable handling
    - Export `EVALUATOR_BASELINE`, `WEIGHTS`, `MOVE_PENALTY` constants from one module
    - `evaluate` returns `{ notEvaluable: true }` for Positions that have not passed tests; `scoreOfLine(score, n)` returns `score - n * MOVE_PENALTY`
    - Add a short section to the package README stating the weights, baseline, and Move_Penalty
    - _Requirements: 13.2, 13.3, 13.9, 13.10_

  - [~] 11.3 Write property test for per-function metrics and nesting exclusion
    - **Property 30: Metrics per-function computation and nesting exclusion**
    - **Validates: Requirements 13.1**

  - [~] 11.4 Write property test for score monotonicity
    - **Property 31: Score is a fixed, monotonic affine function of Metrics**
    - **Validates: Requirements 13.2**

  - [~] 11.5 Write property test for cyclomatic complexity
    - **Property 32: Cyclomatic complexity formula correctness**
    - **Validates: Requirements 13.4**

  - [~] 11.6 Write property test for maximum nesting depth
    - **Property 33: Maximum nesting depth formula correctness**
    - **Validates: Requirements 13.5**

  - [~] 11.7 Write property test for function length
    - **Property 34: Function length formula correctness**
    - **Validates: Requirements 13.6**

  - [~] 11.8 Write property test for duplicated code
    - **Property 35: Duplicated code formula correctness**
    - **Validates: Requirements 13.7**

  - [~] 11.9 Write property test for unused code count
    - **Property 36: Unused code count matches declaration classification**
    - **Validates: Requirements 13.8**

  - [~] 11.10 Write property test for Line score arithmetic
    - **Property 37: Line score arithmetic**
    - **Validates: Requirements 13.9**

  - [~] 11.11 Write property test for evaluation determinism
    - **Property 38: Evaluation determinism**
    - **Validates: Requirements 13.10**

- [x] 12. Implement the Annotator
  - [x] 12.1 Implement `annotate` and move-line formatting
    - `annotate(gain, range)`: `!!` at or above 15% of range, `!` at 5% to below 15%, `?!` below 5% or when range is 0; Blunders are `??` upstream
    - `formatMoveLine(index, displayName, annotation)` returns `"<n>. <Move name> <Annotation>"`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_

  - [x] 12.2 Write property test for annotation correctness
    - **Property 44: Annotation function correctness**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6**

  - [x] 12.3 Write property test for move line formatting
    - **Property 45: Move line formatting**
    - **Validates: Requirements 15.7**

- [x] 13. Implement the Test Runner, Test Cache, and coverage
  - [x] 13.1 Implement `TestCache`
    - In-memory map keyed by Content_Hash storing the full `TestOutcome`; one instance per analysis run, no global or on-disk state
    - _Requirements: 11.2, 11.3, 11.5_

  - [x] 13.2 Implement `TestRunner` using the Vitest programmatic API
    - Materialize the candidate into a temp directory mirroring project structure (symlinked `node_modules`), run only the Relevant_Test_File, race against a timeout (default 60 s, configurable for the 300 s apply run), kill on expiry, clean up in `finally`
    - Map results to `passed`, `failed` (with test names and messages), `error` (including zero tests collected), `timeout`
    - Implement `runWithCoverage` using `@vitest/coverage-v8` JSON output; never touch the real Target_File
    - Implement Relevant_Test_File discovery
    - _Requirements: 2.1, 2.4, 2.7, 3.1, 3.4, 10.1, 10.5, 10.6, 10.7, 10.8_

  - [x] 13.3 Implement coverage calculation and warning text
    - `computeCoverage(executed, total)` returns percent rounded to one decimal or unknown when total is 0
    - Shared `coverageMessage(coverage)` producing the warning text (below 60.0) or unknown text, used by both CLI and Web UI
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 13.4 Write property test for coverage percentage formula
    - **Property 4: Coverage percentage formula correctness**
    - **Validates: Requirements 3.1, 3.4, 3.5**

  - [x] 13.5 Write property test for the coverage warning threshold
    - **Property 5: Coverage warning threshold**
    - **Validates: Requirements 3.2, 3.3**

  - [x] 13.6 Write property test for Target_File on-disk immutability
    - **Property 23: Target_File on-disk immutability across Test_Runner outcomes**
    - **Validates: Requirements 10.6**

  - [x] 13.7 Write unit tests for the Test Runner
    - A run over 60 s is killed and classified `timeout`; a missing dependency yields `error`; zero tests collected yields `error`; temp directory removed after failure
    - _Requirements: 10.5, 10.7, 10.8, 2.7_

- [ ] 14. Implement the candidate legality pipeline
  - [~] 14.1 Implement `CandidateEvaluator`
    - Per depth: compute Content_Hash, drop same-depth duplicates (keep first in stable order), check cache, otherwise run the Test_Runner and store the result
    - Classify `Legal_Move` iff outcome is `passed` with at least 1 test; otherwise Blunder (`??`) with failing tests or reason `"timeout"` / `"test execution error"`; Score only Legal_Moves via the Evaluator
    - Use one code path for deterministic and LLM candidates
    - _Requirements: 9.2, 9.6, 10.1, 10.2, 10.3, 10.4, 10.7, 10.8, 11.1, 11.2, 11.3, 11.4, 11.6, 13.3_

  - [~] 14.2 Write property test for TestOutcome classification
    - **Property 22: TestOutcome classification**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.8**

  - [~] 14.3 Write property test for Test_Cache correctness
    - **Property 25: Test_Cache correctness**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.6**

- [ ] 15. Implement LLM-suggested moves
  - [x] 15.1 Implement `LLMProvider` interface and `LLMMoveGenerator`
    - One request per expansion for at most 5 proposals, 30 s timeout, no retry; payload contains only the current Position's source text
    - Discard unparseable proposals and empty or no-op proposals with discard-log entries; on provider error or timeout, return no LLM candidates and record the Position and failure kind
    - With no provider configured, send no requests
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8_

  - [~] 15.2 Write property test for LLM pipeline parity
    - **Property 19: LLM candidate pipeline parity**
    - **Validates: Requirements 9.2**

  - [~] 15.3 Write property test for invalid-proposal discarding
    - **Property 20: LLM invalid-proposal discarding**
    - **Validates: Requirements 9.3**

  - [~] 15.4 Write property test for no-op proposal discarding
    - **Property 21: LLM no-op proposal discarding**
    - **Validates: Requirements 9.8**

  - [~] 15.5 Write unit tests for LLM behaviors
    - No provider means zero requests; request payload contains only Target_File content; provider error and 30 s timeout fall back to deterministic moves and are recorded; failing-test LLM move gets a "tests failed" discard entry
    - _Requirements: 9.4, 9.5, 9.6, 9.7_

- [ ] 16. Implement the Beam Search
  - [~] 16.1 Implement `BeamSearch`
    - Root at depth 0 as the initial empty best Line; expand only kept Positions with at least one Legal_Move; keep top Beam_Width by raw score; defaults Search_Depth 4 and Beam_Width 3
    - Best_Line selection across all Lines of length 0..depth by score after Move_Penalty, ties by fewest Moves then earliest found; empty Best_Line when nothing strictly beats the root
    - Emit a progress event whenever a Position's penalized score strictly exceeds all previous ones, never for the root
    - _Requirements: 14.1, 14.2, 14.3, 14.6, 14.7, 14.8, 14.9_

  - [~] 16.2 Write property test for beam selection
    - **Property 39: Beam selection correctness**
    - **Validates: Requirements 14.2**

  - [~] 16.3 Write property test for Best_Line selection
    - **Property 41: Best_Line selection correctness**
    - **Validates: Requirements 14.6, 14.7**

  - [~] 16.4 Write property test for non-regression
    - **Property 42: Non-regression of the Best_Line**
    - At least 20 generated analyses
    - **Validates: Requirements 14.8, 24.2**

  - [~] 16.5 Write property test for progress event emission
    - **Property 43: Progress event emission correctness**
    - **Validates: Requirements 14.9**

- [ ] 17. Implement the Engine
  - [~] 17.1 Implement `Engine.runPreflight`
    - Locate Relevant_Test_File; run tests on the original Position; measure coverage; return `no-tests`, `tests-failed` (with failing test names), `tests-unrunnable`, or `ok`
    - Provide shared message formatters for the CLI and Web UI
    - Continue to Search after coverage warnings without confirmation
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.6_

  - [~] 17.2 Implement `Engine.analyze` and Recording assembly
    - Wire generator, `CandidateEvaluator`, `BeamSearch`, Annotator, per-run `TestCache`, discard log, LLM failure entries
    - Build a complete `Recording` (all Requirement 16.1 fields, including `sourceBefore`/`sourceAfter` per Best_Line Move, blunders, coverage, settings, progress events)
    - Perform all search work in memory or temp copies; no writes to user files
    - _Requirements: 9.4, 11.5, 14.1, 14.6, 15.7, 16.1, 16.2, 21.1_

  - [~] 17.3 Write property test for failing-test reporting fidelity
    - **Property 3: Failing-test reporting fidelity**
    - **Validates: Requirements 2.5, 2.6**

  - [~] 17.4 Write property test for the accepted-moves-pass invariant
    - **Property 24: Accepted-moves-pass invariant**
    - At least 20 generated analyses
    - **Validates: Requirements 10.9, 24.4**

  - [~] 17.5 Write property test for no writes outside the temp area
    - **Property 57: No writes outside the designated temp area during Search**
    - **Validates: Requirements 21.1, 25.3**

  - [~] 17.6 Write unit tests for preflight and Recording completeness
    - No tests, failing original tests, unrunnable tests; a real small analysis yields a Recording with every Requirement 16.1 field; two Engines have independent caches
    - _Requirements: 2.2, 2.5, 2.7, 11.5, 16.1_

- [~] 18. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 19. Implement the Apply flow
  - [x] 19.1 Implement the apply pipeline
    - Strict order: freshness check (byte-equal to original Position) → Relevant_Test_File run on the Position to write (300 s timeout) → write via temp file and atomic rename
    - Support "Apply best line" (final Position, move count L) and "Apply up to selected move" (`sourceAfter` of index i, move count i + 1); "Reject" leaves file untouched
    - Return distinct results: file-changed, tests failed, could not run, timed out, write failed (original content preserved)
    - _Requirements: 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9_

  - [~] 19.2 Write property test for apply content selection and move count
    - **Property 58: Apply content selection and move count**
    - **Validates: Requirements 21.2, 21.3, 21.6**

  - [~] 19.3 Write property test for the disk-freshness guard
    - **Property 59: Apply disk-freshness guard**
    - **Validates: Requirements 21.5**

  - [~] 19.4 Write property test for apply test-outcome gating
    - **Property 60: Apply test-outcome gating**
    - **Validates: Requirements 21.7, 21.8**

  - [~] 19.5 Write unit tests for apply edge cases
    - Reject leaves the file byte-identical; simulated write I/O error leaves original content and reports "write failed"
    - _Requirements: 21.4, 21.9_

- [ ] 20. Implement shared UI view-model logic (`packages/ui-core`)
  - [x] 20.1 Implement pure view-model modules
    - Eval bar scale (clamp to [originalScore, 0], label to 1 decimal), move navigation (previous, next, jump to end, disabled states), no-textual-change detection, line diff, metrics change formatting and marks (`improved`/`worsened`/`unchanged` by text/symbol), missing-metrics `"unavailable"` handling, blunder log view-model with empty-message indicator, move list formatting
    - _Requirements: 17.2, 17.3, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 19.1, 19.3, 19.4, 19.5, 19.6, 20.1, 20.2, 20.3, 20.4_

  - [~] 20.2 Write property test for eval bar clamping and rounding
    - **Property 51: Eval bar scale clamping and rounding**
    - **Validates: Requirements 17.3**

  - [~] 20.3 Write property test for move navigation logic
    - **Property 52: Move navigation index logic**
    - **Validates: Requirements 18.3, 18.4, 18.5, 18.6, 18.7, 18.8**

  - [~] 20.4 Write property test for no-textual-change detection
    - **Property 53: No-textual-change detection**
    - **Validates: Requirements 18.9**

  - [~] 20.5 Write property test for metrics change formatting and marks
    - **Property 54: Metrics change formatting and mark derivation**
    - **Validates: Requirements 19.4, 19.5**

  - [~] 20.6 Write property test for missing-metrics placeholders
    - **Property 55: Missing-metrics placeholder handling**
    - **Validates: Requirements 19.6**

  - [~] 20.7 Write property test for Blunder log empty-message indicator
    - **Property 56: Blunder log empty-message indicator**
    - **Validates: Requirements 20.3**

- [ ] 21. Implement the CLI and local web server
  - [x] 21.1 Implement argument parsing and validation
    - Parse `analyze <file>` and `--depth`; reject missing argument (usage on stderr), missing file (names path), non-`.ts`/`.tsx` extension, parse errors (path, line, column), and depth other than integer 3 or 4 (states accepted range); all exit non-zero without starting Engine or Web UI
    - _Requirements: 1.3, 1.4, 1.5, 1.8, 14.4, 14.5_

  - [~] 21.2 Write property test for extension validation
    - **Property 1: Extension validation**
    - **Validates: Requirements 1.4**

  - [~] 21.3 Write property test for parse-error location reporting
    - **Property 2: Parse-error location reporting**
    - **Validates: Requirements 1.5**

  - [~] 21.4 Write property test for depth-option validation
    - **Property 40: Depth-option validation**
    - **Validates: Requirements 14.4, 14.5**

  - [~] 21.5 Implement the Web UI server
    - Express + `ws` server: serve static Web UI bundle, `GET /api/recording`, `WS /ws` (progress events, depth, positions tested, final Recording), `POST /api/apply`
    - Select a free port when the default is in use; open the default browser and print the URL; on browser failure print the URL with a notice and keep running
    - _Requirements: 1.1, 1.2, 1.6, 1.7, 17.1, 17.4, 21.6_

  - [~] 21.6 Wire the CLI end to end
    - Run preflight and print the shared messages (needs tests, failing tests, unrunnable, coverage warning or unknown) and exit non-zero as required; start server and `Engine.analyze`; stream events; handle apply and reject (end session within 1 s)
    - Start the Engine and Web UI within 10 s of the command
    - _Requirements: 1.1, 2.2, 2.3, 2.5, 2.6, 2.7, 3.2, 3.3, 3.4, 3.5, 21.2, 21.3, 21.4_

  - [~] 21.7 Write unit and integration tests for the CLI
    - Missing file, wrong extension, no argument, invalid depth, port-in-use fallback, browser-open failure message, no-tests message in CLI and Web UI
    - _Requirements: 1.3, 1.4, 1.6, 1.7, 1.8, 2.2, 2.3, 14.5_

- [ ] 22. Implement the Web UI and Replay Demo
  - [~] 22.1 Build the live Web UI app
    - React app consuming `ui-core`: Eval_Bar (update within 500 ms), move list, depth and positions-tested display, diff viewer with navigation, metrics panel, Blunder log, coverage warning, no-tests and failing-test messages, apply controls ("Apply best line", "Apply up to selected move", "Reject") with result display (path and move count), disconnect message within 5 s retaining last values
    - Select the first Move on load; show "no improvement found" and disabled controls for an empty Best_Line
    - _Requirements: 2.3, 2.6, 3.2, 3.4, 16.3, 17.1, 17.2, 17.4, 17.5, 17.6, 18.1, 18.2, 18.8, 19.1, 19.2, 20.1, 21.6_

  - [~] 22.2 Build the static Replay Demo
    - Reuse the same `ui-core` components; load the bundled Recording, parse with `RecordingParser`, start playback of `progressEvents` within 3 s in recorded order
    - Disable all apply controls and show an always-visible "recorded replay" label; on load or parse failure show which one within 5 s and do not start playback; at the end keep final state and offer a restart control
    - No backend, test runner, or LLM; no network requests except own static assets and the Recording
    - _Requirements: 16.3, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7_

  - [~] 22.3 Write component tests for the Web UI and Replay Demo
    - Fake timers for 500 ms, 200 ms, 3 s, and 5 s windows; empty Best_Line messaging; "no moves broke tests"; disconnect behavior; replay load failure versus parse failure; replay restart; identical rendered values for the same Recording in both apps
    - _Requirements: 16.3, 17.5, 17.6, 18.8, 20.4, 22.2, 22.4, 22.6, 22.7_

- [ ] 23. Create the Sample Project and bundled Recording
  - [x] 23.1 Create the sample messy project
    - `sample-project/` with a 50–300 line messy TypeScript Target_File containing at least one opportunity for each of the five Deterministic_Moves and at least one opportunity whose result breaks a test, plus a Vitest file where all tests pass with zero skipped
    - _Requirements: 23.1, 23.2, 23.3, 23.4_

  - [~] 23.2 Generate and commit the bundled Recording
    - Add a script that runs the Engine on the sample file with default settings and writes `sample-project/recording.json`; the Recording must parse, have a Best_Line of at least 3 Moves, and include at least one Blunder with test name and message; wire it into the Replay Demo assets
    - _Requirements: 23.5, 23.6, 22.1_

  - [~] 23.3 Write smoke tests for the Sample Project
    - Tests pass on the unmodified file; each Deterministic_Move yields a candidate; the bundled Recording parses with Best_Line of at least 3 Moves and at least one Blunder; analysis finishes in 120 s or less
    - _Requirements: 23.2, 23.3, 23.4, 23.5, 23.6_

- [ ] 24. Implement the MCP server (stretch goal)
  - [~] 24.1 Implement the `find_best_refactoring_line` tool
    - One required `path` input; validate existence and `.ts`/`.tsx` before starting the Engine and return an error naming the path and reason; return Best_Line moves with annotations plus original and final Metrics; empty Best_Line with identical Metrics is not an error; forward Engine errors with no partial Best_Line; never write to project files
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6_

  - [~] 24.2 Write property test for invalid path rejection
    - **Property 61: MCP invalid-path rejection**
    - **Validates: Requirements 25.5**

  - [~] 24.3 Write unit tests for MCP wiring
    - Tool schema, success result shape, no-improvement result, Engine error pass-through, byte-identical files after invocation
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.6_

- [~] 25. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties; unit tests validate specific examples and edge cases
- The MCP server (task 24) is a stretch goal and can be deferred

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "23.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "12.1", "13.1", "13.2", "13.3"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "4.1", "5.1", "6.1", "7.1", "8.1", "12.2", "12.3", "13.4", "13.5", "13.6", "13.7", "15.1", "19.1", "20.1", "21.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5", "5.2", "5.3", "6.2", "6.3", "7.2", "8.2", "8.3", "8.4", "8.5", "9.1", "11.1", "15.3", "15.4", "15.5", "19.2", "19.3", "19.4", "19.5", "20.2", "20.3", "20.4", "20.5", "20.6", "20.7", "21.2", "21.3", "21.4"] },
    { "id": 5, "tasks": ["9.2", "9.3", "9.4", "9.5", "11.2", "11.3", "11.5", "11.6", "11.7", "11.8", "11.9"] },
    { "id": 6, "tasks": ["11.4", "11.10", "11.11", "14.1"] },
    { "id": 7, "tasks": ["14.2", "14.3", "15.2", "16.1"] },
    { "id": 8, "tasks": ["16.2", "16.3", "16.4", "16.5", "17.1"] },
    { "id": 9, "tasks": ["17.2"] },
    { "id": 10, "tasks": ["17.3", "17.4", "17.5", "17.6", "21.5", "24.1"] },
    { "id": 11, "tasks": ["21.6", "22.1", "22.2", "23.2", "24.2", "24.3"] },
    { "id": 12, "tasks": ["21.7", "22.3", "23.3"] }
  ]
}
```
