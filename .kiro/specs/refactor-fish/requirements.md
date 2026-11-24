# Requirements Document

## Introduction

Refactor-fish is a chess-engine-style refactoring tool for TypeScript files. It treats the current code of one file as a "position", a single safe refactoring as a "move", and a failing test as a "blunder". Using beam search, it explores sequences of refactoring moves, runs the project's Vitest tests after every candidate, scores only test-passing code with code-quality metrics, and presents the best line of moves with chess-style annotations, an eval bar, before/after metrics, and a final diff. The user runs `npx refactor-fish analyze <file>`, reviews the result in a local web UI, and chooses whether to apply it. A hosted replay demo plays back a recorded analysis of a sample messy file.

Guiding rules: tests always decide, the LLM only suggests, and the engine never writes to user files without approval.

Scope: TypeScript files only, single-file refactoring, five deterministic moves plus LLM-suggested moves, beam search of depth 3 to 4, CLI plus local web UI, hosted replay demo, and a sample messy project with tests. Out of scope: other languages, multi-file refactoring, IDE plugins, and deep search on large codebases. Stretch goal: an MCP server.

## Glossary

- **Refactor_Fish**: The overall tool, comprising the CLI, Engine, and Web_UI.
- **CLI**: The command-line entry point started by `npx refactor-fish analyze <file>`.
- **Engine**: The component that generates candidate moves, checks legality, evaluates positions, and runs the search.
- **Target_File**: The single TypeScript file the user asks Refactor_Fish to analyze.
- **Position**: The full source text of the Target_File at one point in a search.
- **Move**: One refactoring applied to a Position, expressed as a syntax-tree edit.
- **Move_Generator**: The component that produces candidate Moves for a Position.
- **Deterministic_Move**: A Move from the fixed catalog: Remove_Unused, Inline_Variable, Guard_Clause, Simplify_Boolean, Extract_Function.
- **Remove_Unused**: A Deterministic_Move that removes unused imports, variables, or functions.
- **Inline_Variable**: A Deterministic_Move that replaces a variable referenced exactly once with its initializer expression.
- **Guard_Clause**: A Deterministic_Move that converts nested conditionals into early returns.
- **Simplify_Boolean**: A Deterministic_Move that rewrites `x === true` to `x`, `!!x` to `x` where the value is used in a boolean context, and `if (c) return true; else return false;` to `return c;`.
- **Extract_Function**: A Deterministic_Move that moves a block of statements into a new named function and replaces the block with a call.
- **LLM_Move**: A Move proposed by a language model and treated as a candidate like any other.
- **LLM_Provider**: The external language model service used to propose LLM_Moves.
- **AST_Editor**: The ts-morph-based component that applies Moves as syntax-tree edits.
- **Test_Runner**: The component that runs Vitest against a Position.
- **Test_Cache**: The store of test results keyed by the content hash of a Position.
- **Content_Hash**: A hash of the exact source text of a Position.
- **Legal_Move**: A Move whose resulting Position passes the relevant tests.
- **Blunder**: A Move whose resulting Position fails at least one test.
- **Evaluator**: The component that computes the Score of a Position.
- **Metrics**: Cyclomatic complexity, maximum nesting depth, function length, duplicated code, and unused code, each summed across all functions in the Target_File.
- **Score**: The single number the Evaluator computes from the Metrics. A higher Score means better code.
- **Move_Penalty**: A fixed per-move deduction applied to the Score of a Line, so that shorter Lines are preferred.
- **Search**: The beam search over Move sequences.
- **Beam_Width**: The number of best Positions kept at each depth of the Search.
- **Search_Depth**: The maximum number of Moves in a Line, between 3 and 4 inclusive.
- **Line**: An ordered sequence of Moves starting from the original Position.
- **Best_Line**: The Line with the highest Score after applying the Move_Penalty.
- **Annotation**: A chess-style symbol on a Move: `!!` brilliant, `!` good, `?!` dubious, `??` blunder.
- **Recording**: A JSON document describing a complete analysis, shared by the live Web_UI and the Replay_Demo.
- **Web_UI**: The local web page served by the CLI that displays the analysis.
- **Eval_Bar**: The Web_UI bar that shows the current best Score.
- **Replay_Demo**: The hosted static site that plays back a Recording of the Sample_Project.
- **Sample_Project**: A bundled messy TypeScript project with Vitest tests used for testing and for the Replay_Demo.
- **Relevant_Test_File**: The test file(s) that import the Target_File, directly or through the project's Vitest configuration.
- **MCP_Server**: The stretch-goal Model Context Protocol server that exposes Best_Line search to an agent.

## Requirements

### Requirement 1: Launch analysis from the CLI

**User Story:** As a developer, I want to run one command on a file, so that I can start an analysis without configuration.

#### Acceptance Criteria

1. WHEN the user runs `npx refactor-fish analyze <file>` with an existing TypeScript file that has a `.ts` or `.tsx` extension and parses without errors, THE CLI SHALL start the Engine on that Target_File and start the Web_UI on a local port within 10 seconds of the command being run.
2. WHEN the Web_UI server is ready to accept connections, THE CLI SHALL open the Web_UI URL in the default browser and print the URL to standard output.
3. IF the specified file does not exist, THEN THE CLI SHALL print an error naming the missing path to standard error, exit with a non-zero status, and not start the Engine or the Web_UI.
4. IF the specified file does not have a `.ts` or `.tsx` extension, THEN THE CLI SHALL print a message to standard error stating that only TypeScript files are supported, exit with a non-zero status, and not start the Engine or the Web_UI.
5. IF the Target_File fails to parse as TypeScript, THEN THE CLI SHALL print the parse error with its file path, line number, and column number to standard error, exit with a non-zero status, and not start the Web_UI.
6. IF the default local port is in use, THEN THE CLI SHALL select another free local port, start the Web_UI on that port, and print the chosen URL to standard output.
7. IF the CLI cannot open the default browser, THEN THE CLI SHALL print the Web_UI URL to standard output with a message that the browser could not be opened, and keep the Web_UI running.
8. IF the user runs `npx refactor-fish analyze` without a `<file>` argument, THEN THE CLI SHALL print a usage message showing the expected command syntax to standard error and exit with a non-zero status.

### Requirement 2: Require tests before searching

**User Story:** As a developer, I want a clear message when my project has no tests, so that I understand why no analysis ran.

#### Acceptance Criteria

1. WHEN an analysis starts, THE Engine SHALL locate the Relevant_Test_File for the Target_File before the Search begins.
2. IF no Relevant_Test_File exists for the Target_File, THEN THE CLI SHALL print a message stating that Refactor-fish needs tests, exit with a non-zero status, and not run the Search, leaving the Target_File unmodified.
3. IF no Relevant_Test_File exists for the Target_File, THEN THE Web_UI SHALL display the same message stating that Refactor-fish needs tests, not run the Search, and leave the Target_File unmodified.
4. WHEN the Relevant_Test_File exists, THE Test_Runner SHALL run it against the original Position before the Search begins.
5. IF the original Position fails its tests, THEN THE CLI SHALL print the name of each failing test, exit with a non-zero status, and not run the Search.
6. IF the original Position fails its tests, THEN THE Web_UI SHALL display the name of each failing test and not run the Search.
7. IF the Test_Runner cannot execute the Relevant_Test_File (for example, a syntax error, a missing dependency, or zero tests collected), THEN THE CLI SHALL print a message stating that the tests could not be run, exit with a non-zero status, and not run the Search.

### Requirement 3: Warn on weak test coverage

**User Story:** As a developer, I want a warning when my tests cover little of the file, so that I know a "safe" move may not be verified.

#### Acceptance Criteria

1. WHEN the original Position passes its tests, THE Test_Runner SHALL measure the statement coverage of the Target_File by the Relevant_Test_File as the number of executed statements divided by the total number of statements in the Target_File, expressed as a percentage from 0 to 100 rounded to one decimal place.
2. IF the measured statement coverage is below 60.0 percent, THEN THE Web_UI SHALL display a coverage warning stating the measured percentage, and SHALL NOT display the warning when the measured coverage is 60.0 percent or above.
3. IF the measured statement coverage is below 60.0 percent, THEN THE CLI SHALL print the same coverage warning text as the Web_UI, and SHALL NOT print the warning when the measured coverage is 60.0 percent or above.
4. IF coverage cannot be measured because the coverage run fails, does not finish within 60 seconds, or the Target_File contains zero statements, THEN THE Web_UI SHALL display a message stating that coverage is unknown.
5. IF coverage cannot be measured for any reason listed in criterion 4, THEN THE CLI SHALL print a message stating that coverage is unknown.
6. WHEN a coverage warning or a coverage-unknown message is displayed, THE Engine SHALL continue to run the Search without requiring user confirmation.

### Requirement 4: Remove unused code

**User Story:** As a developer, I want unused imports, variables, and functions removed, so that dead code stops hiding the real logic.

#### Acceptance Criteria

1. WHEN a Position contains one or more unused imports, variables, or functions, THE Move_Generator SHALL generate exactly one Remove_Unused candidate for each unused declaration, and SHALL generate no Remove_Unused candidate for a declaration that is used.
2. WHEN a Remove_Unused Move is applied, THE AST_Editor SHALL delete only the targeted declaration through a syntax-tree edit, leave all other declarations unchanged, and produce a resulting Position that parses with zero syntax errors.
3. IF a declaration is exported, or at least one reference to its symbol exists in the Target_File outside the declaration's own body, THEN THE AST_Editor SHALL classify the declaration as used and SHALL NOT remove it.
4. FOR ALL Positions and Remove_Unused Moves, THE AST_Editor SHALL leave every referenced symbol declared in the resulting Position (referenced-symbol preservation property).
5. IF a Remove_Unused Move cannot be applied because the syntax-tree edit fails or the edited result does not parse, THEN THE AST_Editor SHALL reject the Move, leave the Position identical to its state before the Move, and return an error indicating the reason for rejection.
6. WHEN a Remove_Unused Move targets one specifier of an import statement that has more than one specifier, THE AST_Editor SHALL remove only that specifier and keep the import statement. WHEN the Move targets the only specifier of an import statement, THE AST_Editor SHALL remove the entire import statement.

### Requirement 5: Inline single-use variables

**User Story:** As a developer, I want single-use variables inlined, so that trivial indirection disappears.

#### Acceptance Criteria

1. WHEN a `const` declaration binds a single identifier (not a destructuring pattern), has an initializer, and its identifier has exactly one reference in the Target_File (not counting the declaration itself), THE Move_Generator SHALL generate one Inline_Variable candidate for it.
2. WHEN an Inline_Variable Move is applied, THE AST_Editor SHALL replace the single reference with the initializer expression, adding parentheses where needed to preserve the initializer's operator precedence. It SHALL also expand a shorthand property reference `{ x }` to `{ x: <initializer> }`, delete the declaration, and produce a Position that parses as valid TypeScript. If the declaration statement declares other variables, THE AST_Editor SHALL delete only the inlined declarator.
3. IF the execution path from the declaration to the reference contains a side-effecting expression, or a reassignment of any variable that the initializer reads, THEN THE Move_Generator SHALL NOT generate the Inline_Variable candidate. A side-effecting expression is a function call, `new` expression, `await`, `yield`, assignment, increment or decrement, `delete`, or tagged template.
4. IF the variable is exported, THEN THE Move_Generator SHALL NOT generate the Inline_Variable candidate. A variable is exported if it has an `export` modifier or appears in an export specifier or default export.
5. IF the single reference is inside a nested function, a loop body, or a conditionally evaluated branch (`if`/`else` branch, `&&`, `||`, `??`, or ternary operand) that does not contain the declaration, AND the initializer contains a side-effecting expression, THEN THE Move_Generator SHALL NOT generate the Inline_Variable candidate.

### Requirement 6: Convert nested conditionals to guard clauses

**User Story:** As a developer, I want nested ifs flattened into early returns, so that the main path reads linearly.

#### Acceptance Criteria

1. WHEN the Move_Generator examines a function, method, or arrow function with a block body that contains an `if` statement without an `else` branch, and that `if` statement is followed by no other statement or only by a single `return` statement, THE Move_Generator SHALL generate exactly one Guard_Clause candidate for that `if` statement.
2. WHEN a Guard_Clause Move is applied, THE AST_Editor SHALL replace the wrapping `if` statement with an `if` statement whose condition is the logical negation of the original condition and whose body is a single early `return`, followed by the statements of the original `if` body placed at the nesting level of the replaced `if` statement.
3. WHEN a Guard_Clause Move is applied to a function with a `void` return type, THE AST_Editor SHALL emit a bare `return;` as the early return.
4. WHEN a Guard_Clause Move is applied to a function with a non-void return type, THE AST_Editor SHALL emit as the early return the expression of the `return` statement that follows the wrapping `if` statement, or `return undefined;` if no `return` statement follows and the return type includes `undefined`.
5. IF the wrapping `if` statement is followed by any statement other than a single `return` statement, or is followed by nothing in a function whose return type is non-void and does not include `undefined`, THEN THE Move_Generator SHALL NOT generate the Guard_Clause candidate.
6. IF unwrapping the `if` body would declare a `let`, `const`, `class`, or function name that is already declared in the enclosing function scope, THEN THE Move_Generator SHALL NOT generate the Guard_Clause candidate.

### Requirement 7: Simplify boolean expressions

**User Story:** As a developer, I want redundant boolean constructs simplified, so that conditions say what they mean.

#### Acceptance Criteria

1. WHEN an expression of the form `x === true` has an operand `x` whose static type is exactly `boolean`, THE AST_Editor SHALL rewrite that expression to `x` and leave all other source text in the file unchanged.
2. WHEN an expression of the form `!!x` appears directly as the condition of an `if`, `while`, or ternary, or as an operand of `&&` or `||` whose result is used as such a condition or whose operand `x` has static type `boolean`, THE AST_Editor SHALL rewrite `!!x` to `x` and leave all other source text in the file unchanged.
3. WHEN an `if (c) return true; else return false;` statement is present, with or without braces around either branch, and the static type of `c` is exactly `boolean`, THE AST_Editor SHALL rewrite the statement to `return c;`.
4. IF the static type of the operand is not exactly `boolean` for a rewrite in criterion 1 or 3, or the static type cannot be determined (including `any`, `unknown`, and union types containing a non-boolean member), THEN THE Move_Generator SHALL NOT generate a Simplify_Boolean candidate for that expression and SHALL leave the source unchanged.
5. WHEN several Simplify_Boolean rewrites exist in a Position, THE Move_Generator SHALL generate exactly one candidate Move per rewrite site, and applying any one candidate SHALL change only its own site.

### Requirement 8: Extract function

**User Story:** As a developer, I want a block pulled into a named function, so that long functions become readable units.

#### Acceptance Criteria

1. WHEN a function contains a contiguous sequence of at least 5 statements in the same block scope, and every identifier the sequence references is either declared inside the sequence or is a variable from the enclosing function's scope that can be passed as an argument, THE Move_Generator SHALL generate an Extract_Function candidate. Only statements directly in the sequence count toward the 5. Statements nested inside them do not count.
2. WHEN an Extract_Function Move is applied, THE AST_Editor SHALL create a new function in the Target_File and replace the block with a call to it. The new function SHALL have exactly one parameter for each distinct outer variable the block reads, in order of first read. The call SHALL pass each of those variables as an argument.
3. WHEN the extracted block assigns to one or more outer variables, or ends with a `return` that yields a value, THE AST_Editor SHALL return each such value from the new function and assign it at the call site. After the Move, each outer variable SHALL hold the same value it would have held had the block run in place.
4. THE AST_Editor SHALL give each extracted function a name that differs from every identifier declared or referenced in the Target_File scope chain at the extraction point. It SHALL also differ from every identifier inside the extracted block. If the base name is taken, the AST_Editor SHALL append the lowest integer suffix, starting at 2, that makes the name unique.
5. IF the block contains a `return` that is not its final statement, a `break` or `continue` whose target loop or label is outside the block, or an `await` where the new function cannot be declared async because the enclosing function is not async, THEN THE Move_Generator SHALL NOT generate an Extract_Function candidate for that block.
6. IF applying an Extract_Function Move produces a Target_File that fails to parse, THEN THE AST_Editor SHALL leave the Target_File unchanged and report an error indicating that the extraction failed.

### Requirement 9: LLM-suggested moves

**User Story:** As a developer, I want an AI to propose refactorings beyond the fixed catalog, so that the engine can find non-obvious improvements while tests still decide.

#### Acceptance Criteria

1. WHERE an LLM_Provider is configured, WHEN the Search expands a Position, THE Move_Generator SHALL send one request to the LLM_Provider for that Position, asking for at most 5 LLM_Move proposals.
2. WHEN the LLM_Provider returns a proposal that parses as valid TypeScript, THE Engine SHALL treat the resulting Position as a candidate and apply the same test execution, scoring, and Line eligibility rules that apply to a Deterministic_Move.
3. IF the LLM_Provider returns a proposal that does not parse as valid TypeScript, THEN THE Engine SHALL discard that proposal, add an entry to the discard log containing the proposal and the parse failure reason, and continue the Search with the remaining proposals.
4. IF the LLM_Provider returns an error or does not respond within 30 seconds, THEN THE Engine SHALL make no retry for that Position, continue the Search with Deterministic_Moves only for that Position, and add an entry to the Recording stating the Position and whether the failure was an error or a timeout.
5. WHERE no LLM_Provider is configured, THE Engine SHALL run the Search with Deterministic_Moves only and send no requests to any LLM_Provider.
6. IF the Position resulting from an LLM_Move fails the tests, THEN THE Engine SHALL exclude that LLM_Move from every Line and add an entry to the discard log stating that the tests failed.
7. THE Engine SHALL include in each request to the LLM_Provider the content of the Target_File as it exists in the Position being expanded, and no content from any other file.
8. IF the LLM_Provider returns a proposal that is empty or yields a Position identical to the Position being expanded, THEN THE Engine SHALL discard the proposal and add an entry to the discard log stating that the proposal made no change.

### Requirement 10: Test every move for legality

**User Story:** As a developer, I want every candidate verified by my tests, so that no accepted move can break my code.

#### Acceptance Criteria

1. WHEN the Move_Generator produces a candidate Position, THE Test_Runner SHALL run the Relevant_Test_File against that Position and return a result before the Engine scores the Position or adds it to the Search.
2. WHEN the Test_Runner completes the Relevant_Test_File with at least 1 test executed and 0 tests failed or errored, THE Engine SHALL classify the Move as a Legal_Move.
3. IF at least 1 test in the Relevant_Test_File fails, THEN THE Engine SHALL classify the Move as a Blunder, annotate it `??`, and discard the resulting Position from the Search without altering any other Position in the Search.
4. WHEN a Blunder is recorded, THE Engine SHALL store the Move description and, for each failing test, the test name and its failure message.
5. THE Test_Runner SHALL run only the Relevant_Test_File and not the full project test suite.
6. THE Test_Runner SHALL run candidate Positions such that the content of the user's Target_File on disk is byte-identical before and after the run, including when the run fails or times out.
7. IF the Test_Runner runs for more than 60 seconds on a candidate, THEN THE Engine SHALL stop the run, classify the Move as a Blunder with the failure reason "timeout", and discard the resulting Position from the Search.
8. IF the Relevant_Test_File cannot be run to completion on a candidate (for example the candidate Position fails to import or parse, or 0 tests are executed), THEN THE Engine SHALL classify the Move as a Blunder with the failure reason "test execution error", store the Move description and the error message, and discard the resulting Position from the Search.
9. FOR ALL Lines returned by the Engine, every Position in the Line SHALL have passed the Relevant_Test_File (accepted-moves-pass property).

### Requirement 11: Cache test results

**User Story:** As a developer, I want identical code never tested twice, so that the search stays fast.

#### Acceptance Criteria

1. WHEN a candidate Position is produced, THE Engine SHALL compute its Content_Hash from the exact source text of the Position before invoking the Test_Runner.
2. WHEN the Test_Cache contains a result for the Content_Hash of a candidate Position, THE Engine SHALL reuse the cached result and SHALL NOT invoke the Test_Runner for that candidate.
3. WHEN the Test_Runner completes or times out on a candidate Position, THE Test_Cache SHALL store the pass or fail result, the failing test names and failure messages, and the failure reason "timeout" where applicable, under the Content_Hash of that Position.
4. WHEN two or more candidates at the same depth have equal Content_Hash values, THE Engine SHALL keep the first candidate in the Move_Generator's stable order, discard the others before testing, and invoke the Test_Runner at most once for that Content_Hash.
5. THE Engine SHALL create an empty Test_Cache when an analysis run starts, SHALL NOT read from or write to any Test_Cache outside that run, and SHALL discard the Test_Cache when the run ends.
6. WHEN a cached result is a failure, THE Engine SHALL classify the Move as a Blunder using the cached failing test details, with the same classification and annotation as an uncached failure.

### Requirement 12: Deterministic moves

**User Story:** As a developer, I want the same move on the same code to always give the same result, so that analyses are reproducible.

#### Acceptance Criteria

1. WHEN the same Deterministic_Move is applied to the same Position, THE AST_Editor SHALL produce byte-identical output, regardless of how many times, in which process, or at what time the Move is applied.
2. WHEN the Move_Generator is invoked for a given Position, THE Move_Generator SHALL return the candidate Moves in the same order on every invocation, with the same Position always yielding the same ordered list across at least 100 repeated invocations.
3. FOR ALL Positions and Deterministic_Moves, applying the Move twice independently from the same Position SHALL yield byte-identical results (determinism property).
4. WHEN a Move is applied, THE AST_Editor SHALL preserve every comment attached to a retained statement, with its text, its position relative to that statement (leading, trailing, or inline), and its order relative to other comments unchanged.
5. IF a Move is applied to a Position where the Move is not applicable or the resulting code cannot be produced, THEN THE AST_Editor SHALL return an error indicating the reason and SHALL leave the original Position unchanged.

### Requirement 13: Evaluate positions

**User Story:** As a developer, I want a single number that reflects code quality, so that the engine can compare positions objectively.

#### Acceptance Criteria

1. WHEN the Evaluator computes the Metrics for a Position, THE Evaluator SHALL compute each of the five Metrics (cyclomatic complexity, maximum nesting depth, function length, duplicated code, unused code) for every function in the Target_File, including nested functions, methods, and arrow functions, and SHALL sum each Metric across those functions. Each function is measured separately, and the measurement of an outer function excludes the body of any function nested inside it.
2. WHEN the Metrics for a Position have been computed, THE Evaluator SHALL compute one Score by multiplying each Metric by a fixed weight and subtracting the weighted sum from a fixed baseline, so that lower Metric values produce a higher Score. The weights and baseline SHALL be the same for every Position and every run, and SHALL be stated in the Refactor_Fish documentation.
3. IF a Position has not passed the Relevant_Test_File, THEN THE Evaluator SHALL NOT compute a Score for it and SHALL report it as not evaluable.
4. WHEN Metrics are computed, THE Evaluator SHALL compute the cyclomatic complexity of each function as 1 plus the number of the following in that function: `if` statements, `for`, `for...in`, `for...of`, `while`, and `do...while` loops, non-default `case` clauses, `catch` clauses, conditional (`?:`) expressions, and the `&&`, `||`, and `??` operators.
5. WHEN Metrics are computed, THE Evaluator SHALL compute the maximum nesting depth of each function as the largest number of control structures (`if`, `for`, `for...in`, `for...of`, `while`, `do...while`, `switch`, `try`) enclosing any single statement in that function. A function containing no control structures has a maximum nesting depth of 0.
6. WHEN Metrics are computed, THE Evaluator SHALL compute the function length of each function as the number of source lines from the first line to the last line of the function, inclusive.
7. WHEN Metrics are computed, THE Evaluator SHALL compute duplicated code as the total number of statements in every occurrence, other than the first, of a block of at least 3 consecutive statements that appears two or more times without overlap in the Target_File. Two blocks are identical if their source text is equal after trimming leading and trailing whitespace on each line and collapsing every run of whitespace to a single space.
8. WHEN Metrics are computed, THE Evaluator SHALL compute unused code as the total number of imports, variables, and functions that are not exported and have no reference to their symbol in the Target_File.
9. WHEN the Evaluator computes the Score of a Line, THE Evaluator SHALL subtract the Move_Penalty once for each Move in the Line, so that a Line of N Moves has the Score of its final Position minus N times the Move_Penalty, and a Line of 0 Moves has no deduction.
10. FOR ALL Positions, THE Evaluator SHALL return an identical Score on every call for the same Content_Hash, regardless of call order, number of calls, or time of call (evaluation determinism).

### Requirement 14: Beam search for the best line

**User Story:** As a developer, I want the engine to explore move sequences, so that it finds combinations better than any single move.

#### Acceptance Criteria

1. WHEN the Search starts, THE Engine SHALL use the original Position as the root at depth 0 and SHALL treat the root as the initial best Line (an empty Line) with the root's Score.
2. WHILE the current depth is below the Search_Depth, THE Engine SHALL expand each kept Position that has at least one Legal_Move with all of its Legal_Move candidates, keep the top Beam_Width Positions by Score (all of them if fewer than Beam_Width exist), and increase the depth by 1 per expansion round. A kept Position with no Legal_Move is not expanded.
3. THE Engine SHALL use a default Search_Depth of 4 and a default Beam_Width of 3.
4. WHERE the user supplies a depth option, THE CLI SHALL accept only integer values from 3 to 4 inclusive and use the supplied value as the Search_Depth. WHERE the user supplies no depth option, THE CLI SHALL use the default Search_Depth.
5. IF the user supplies a depth option that is not an integer from 3 to 4 inclusive, THEN THE CLI SHALL reject it with an error message stating the accepted range, SHALL NOT start the Search, and SHALL exit with a non-zero exit status.
6. WHEN the Search completes, THE Engine SHALL select as the Best_Line the Line with the highest Score after the Move_Penalty, considering Lines of every length from 0 to the Search_Depth. If several Lines share the highest Score, THE Engine SHALL select the one with the fewest moves, and among those the one found first.
7. IF no Line of length 1 to Search_Depth has a Score after the Move_Penalty strictly greater than the Score of the original Position, THEN THE Engine SHALL return an empty Best_Line and report that no improvement was found.
8. FOR ALL analyses, THE Score of the Best_Line (after the Move_Penalty) SHALL be greater than or equal to the Score of the original Position (non-regression property), and SHALL equal it when the Best_Line is empty.
9. WHEN a Position whose Score after the Move_Penalty is strictly higher than that of every previously found Position in the Search is found during the Search, THE Engine SHALL emit a progress event containing that Position's Score and Line before the Search completes. THE Engine SHALL NOT emit a progress event for the root.

### Requirement 15: Annotate moves

**User Story:** As a developer, I want each move graded in chess notation, so that I can see at a glance which moves matter.

#### Acceptance Criteria

1. WHEN a Legal_Move's Score gain is at least 15 percent of the original Position's Score range, THE Engine SHALL annotate it `!!`, where Score gain is the Score of the resulting Position minus the Score of its parent Position, excluding the Move_Penalty, compared without rounding.
2. WHEN a Legal_Move's Score gain is at least 5 percent and below 15 percent of the original Position's Score range, THE Engine SHALL annotate it `!`.
3. WHEN a Legal_Move's Score gain is below 5 percent of the original Position's Score range, including zero or negative, THE Engine SHALL annotate it `?!`.
4. WHEN a Move is classified as a Blunder, THE Engine SHALL annotate it `??` and SHALL NOT assign it `!!`, `!`, or `?!`.
5. THE Engine SHALL define the original Position's Score range as the absolute difference between the original Score and the maximum achievable Score of 0 on the Evaluator's scale, which equals the absolute value of the original Score.
6. IF the original Position's Score range is 0, THEN THE Engine SHALL annotate every Legal_Move `?!`.
7. WHEN the Best_Line is displayed or recorded, THE Engine SHALL format each Move on its own line as `<n>. <Move name> <Annotation>`, where `<n>` is the 1-based position of the Move in the Line and `<Move name>` is the Move's display name, for example `1. Guard clause !`.

### Requirement 16: Record analyses in a shared format

**User Story:** As a developer, I want a single recording format, so that the live UI and the hosted demo show identical data.

#### Acceptance Criteria

1. WHEN an analysis completes, THE Engine SHALL emit a Recording as a single JSON document containing the Target_File name, original source, Metrics and Score of the original Position, all searched Lines, the Best_Line, each Move with its Annotation, intermediate source for every Position in the Best_Line, Blunders with failing tests, coverage information, and search settings.
2. THE Recording SHALL include a format version field containing a single integer version number.
3. THE Web_UI and THE Replay_Demo SHALL both render every field listed in criterion 1 from the Recording format, such that the same Recording produces identical displayed values for Score, Best_Line Moves, Annotations, Blunders, and coverage in both.
4. IF a Recording document is not valid JSON, THEN THE Recording parser SHALL reject it, return an error indicating the document is malformed JSON, and produce no Recording.
5. IF a Recording document is missing one or more required fields, THEN THE Recording parser SHALL reject it, return an error naming the first missing field in the order listed in criterion 1, and produce no partial Recording.
6. IF a required field in a Recording document has a value of the wrong type, THEN THE Recording parser SHALL reject it, return an error naming the field and the expected type, and produce no partial Recording.
7. WHEN a valid Recording is given to THE Recording printer, THE Recording printer SHALL serialize it to a JSON document that includes every field listed in criterion 1 and the format version field.
8. FOR ALL valid Recordings, parsing then printing then parsing SHALL produce a Recording equal to the first parsed Recording in every field (round-trip property).
9. IF the Recording format version is not among the versions supported by THE Recording parser, THEN THE Recording parser SHALL reject the document and return an error stating the version found and the list of versions supported.

### Requirement 17: Live eval bar and move list

**User Story:** As a developer, I want to watch the engine think, so that I can see progress and trust the result.

#### Acceptance Criteria

1. WHEN the Engine emits a progress event with a new best Position while the Search is running, THE Web_UI SHALL update the Eval_Bar to that Position's Score within 500 milliseconds of receiving the event.
2. WHEN the Search completes, THE Web_UI SHALL display the Best_Line as a move list with one entry per Move in the notation `<n>. <Move name> <Annotation>`, ordered from the first Move to the last.
3. THE Eval_Bar SHALL show the Score on a scale whose minimum is the original Position's Score and whose maximum is 0, clamp the bar fill to that range, and display the numeric Score rounded to 1 decimal place.
4. WHILE the Search is running, THE Web_UI SHALL display the current depth and the number of Positions tested, updated within 500 milliseconds of each change.
5. IF the connection between the Web_UI and the CLI server is lost, THEN THE Web_UI SHALL display a disconnected message within 5 seconds of the loss and keep showing the last received Eval_Bar value, depth, Positions tested count, and move list.
6. IF the Search completes with an empty Best_Line, THEN THE Web_UI SHALL display a message indicating that no improvement was found in place of the move list.

### Requirement 18: Diff viewer

**User Story:** As a developer, I want to step through each move's diff, so that I can judge each change.

#### Acceptance Criteria

1. WHEN the Web_UI loads a Recording whose Best_Line contains at least one Move, THE Web_UI SHALL select the first Move of the Best_Line and display a line-based diff between the Position before that Move and the Position after it, with removed lines and added lines visually distinguished from each other and from unchanged lines.
2. WHEN a Move is selected, THE Web_UI SHALL display a diff between the Position before that Move and the Position after it, and SHALL display the Move's 1-based index and the total number of Moves in the Best_Line.
3. WHEN the user activates "previous" and a previous Move exists, THE Web_UI SHALL select the Move immediately before the currently selected Move in the Best_Line and display its diff within 200 ms.
4. WHEN the user activates "next" and a next Move exists, THE Web_UI SHALL select the Move immediately after the currently selected Move in the Best_Line and display its diff within 200 ms.
5. WHEN the user activates "jump to end", THE Web_UI SHALL select the last Move of the Best_Line and display the cumulative diff between the original Position and the final Position of the Best_Line within 200 ms.
6. WHILE the first Move is selected, THE Web_UI SHALL disable the "previous" control.
7. WHILE the last Move is selected, THE Web_UI SHALL disable the "next" control.
8. IF the Best_Line contains zero Moves, THEN THE Web_UI SHALL display a message stating that no refactoring was found, disable the "previous", "next", and "jump to end" controls, and display no diff.
9. IF the Position before and the Position after the selected Move have identical source text, THEN THE Web_UI SHALL display a message stating that the Move produced no textual change.

### Requirement 19: Metrics panel

**User Story:** As a developer, I want before-and-after numbers, so that I can see how much better the code is.

#### Acceptance Criteria

1. WHEN the Web_UI displays an analysis, THE Web_UI SHALL display in the metrics panel, for both the original Position and the selected Position, the whole-number value of each of the five Metrics (cyclomatic complexity, maximum nesting depth, function length, duplicated code, and unused code) as computed by the Evaluator.
2. WHEN the selected Move changes, THE Web_UI SHALL replace the selected-Position values and the change values with those of the newly selected Move's resulting Position within 200 milliseconds.
3. WHILE no Move is selected, THE Web_UI SHALL display the original Position's values as the selected-Position values.
4. WHEN the Web_UI displays the metrics panel, THE Web_UI SHALL display, for each of the five Metrics, the change as the selected-Position value minus the original-Position value, shown as a whole number with an explicit "+" or "-" sign, or "0" when the values are equal.
5. WHEN the change for a Metric is below zero, THE Web_UI SHALL mark that Metric as improved. WHEN the change is above zero, THE Web_UI SHALL mark it as worsened. WHEN the change is zero, THE Web_UI SHALL mark it as unchanged. Each mark SHALL be distinguishable by text or symbol, not by color alone.
6. IF the Metrics for the original Position or the selected Position are missing from the Recording, THEN THE Web_UI SHALL display "unavailable" in place of each missing value and change, and SHALL keep displaying the values that are available.

### Requirement 20: Blunder log

**User Story:** As a developer, I want to see which moves broke tests, so that I understand where the code is fragile.

#### Acceptance Criteria

1. WHEN the Web_UI loads a Recording, THE Web_UI SHALL display a Blunder log listing every Blunder recorded in the Recording, one entry per Blunder, in the order the Blunders were recorded.
2. THE Blunder log SHALL show, for each Blunder, the Move name, the 1-based position of the Move in its Line (for example, 2 for the second Move), and, for each failing test, the test name and its failure message.
3. IF a failing test has no failure message, THEN THE Blunder log SHALL show an empty-message indicator in place of the failure message and still list the test name.
4. IF the Recording contains no Blunders, THEN THE Web_UI SHALL display a message stating that no moves broke tests.

### Requirement 21: Apply changes with approval

**User Story:** As a developer, I want to choose what gets written to my file, so that nothing changes without my consent.

#### Acceptance Criteria

1. THE Engine SHALL NOT create, modify, or delete the Target_File or any other user file from the start of the Search until the Search ends or is cancelled.
2. WHEN the user activates "Apply best line" and confirms, THE CLI SHALL write the final Position of the Best_Line to the Target_File, provided the checks in criteria 5 and 7 have passed.
3. WHEN the user selects a Move in the Best_Line, activates "Apply up to selected move", and confirms, THE CLI SHALL write the Position after that selected Move to the Target_File, provided the checks in criteria 5 and 7 have passed.
4. WHEN the user activates "Reject", THE CLI SHALL leave the Target_File byte-for-byte unchanged and end the session within 1 second.
5. IF the Target_File content on disk differs byte-for-byte from the original Position when the user activates an apply action, THEN THE CLI SHALL refuse to write, leave the Target_File unchanged, not run the Relevant_Test_File, and display a message stating that the file changed since analysis.
6. WHEN an apply action completes with a successful write, THE Web_UI SHALL display the path written and the number of Moves applied, where the number is the count of Moves from the start of the Best_Line through the last applied Move.
7. WHEN an apply action is requested and the check in criterion 5 has passed, THE CLI SHALL run the Relevant_Test_File against the Position to be written and write only if all tests pass within 300 seconds.
8. IF the Relevant_Test_File has any failing test, cannot be run, or does not finish within 300 seconds, THEN THE CLI SHALL NOT write to the Target_File, leave it unchanged, and display a message indicating that the tests failed, could not run, or timed out.
9. IF writing to the Target_File fails, THEN THE CLI SHALL leave the Target_File with its original content and display a message indicating that the write failed.

### Requirement 22: Hosted replay demo

**User Story:** As a hackathon judge, I want to view an analysis without installing anything, so that I can evaluate the project quickly.

#### Acceptance Criteria

1. THE Replay_Demo SHALL be a static site that loads a Recording of the Sample_Project.
2. WHEN the Replay_Demo page finishes loading, THE Replay_Demo SHALL begin playback of the Search progress from the first recorded event within 3 seconds, updating the Eval_Bar to the value stored in the Recording for each recorded event, in recorded order.
3. THE Replay_Demo SHALL provide the same move list, diff viewer, metrics panel, and Blunder log as the Web_UI, populated with the contents of the Recording.
4. THE Replay_Demo SHALL disable every apply control and display a label stating that it is a recorded replay, visible without scrolling at all times.
5. THE Replay_Demo SHALL run without a backend server, test runner, or LLM_Provider, and SHALL make no network requests other than to load the site's own static assets and the Recording.
6. IF the Recording fails to load or parse, THEN THE Replay_Demo SHALL display within 5 seconds an error message that states whether the cause was a load failure or a parse failure, SHALL NOT start playback, and SHALL keep the recorded-replay label displayed.
7. WHEN playback of the last recorded event completes, THE Replay_Demo SHALL stop playback, keep the final Eval_Bar value, move list, diff viewer, metrics panel, and Blunder log displayed, and offer a control to restart playback from the first recorded event.

### Requirement 23: Sample project

**User Story:** As a developer or judge, I want a ready-made messy project with tests, so that I can try the tool and generate the demo.

#### Acceptance Criteria

1. THE Sample_Project SHALL contain one Target_File of 50 to 300 lines of TypeScript and one Vitest test file that is a Relevant_Test_File for that Target_File.
2. THE Sample_Project SHALL contain, in the Target_File, at least one applicable opportunity for each of the five Deterministic_Moves (Remove_Unused, Inline_Variable, Guard_Clause, Simplify_Boolean, Extract_Function), where an opportunity is a location at which the Move_Generator produces a candidate Move of that type.
3. WHEN the Relevant_Test_File is run against the unmodified Target_File, THE Sample_Project tests SHALL all pass with zero failing and zero skipped tests.
4. THE Sample_Project SHALL contain at least one Move opportunity whose resulting Position fails at least one test in the Relevant_Test_File, so that the analysis classifies that Move as a Blunder and the Blunder log contains at least one entry.
5. THE repository SHALL include a Recording of the Sample_Project that is valid under the Recording parser, has a Best_Line of at least 3 Moves, and contains at least one Blunder with its failing test name and failure message, for use by the Replay_Demo.
6. WHEN the Engine analyzes the Sample_Project with default search settings, THE Engine SHALL complete the analysis in 120 seconds or less.

### Requirement 24: Property-based verification of engine guarantees

**User Story:** As a maintainer, I want the key guarantees checked by property-based tests, so that regressions are caught.

#### Acceptance Criteria

1. THE Refactor_Fish test suite SHALL include a property-based test that, for at least 100 generated Positions and each of the five Deterministic_Moves, applying the same Deterministic_Move twice to the same Position yields byte-identical output (Requirement 12.3).
2. THE Refactor_Fish test suite SHALL include a property-based test that, for at least 20 generated Positions each with a Relevant_Test_File, the Score of the Best_Line is greater than or equal to the Score of the original Position, and an empty Best_Line has a Score equal to the original Score (Requirement 14.8).
3. THE Refactor_Fish test suite SHALL include a property-based test that, for at least 100 generated Positions that each have at least one Remove_Unused candidate, every symbol referenced in the Position before the Remove_Unused Move is applied is still declared in the resulting Position (Requirement 4.4).
4. THE Refactor_Fish test suite SHALL include a property-based test that, for at least 20 generated analyses, every Position in every returned Line, including the intermediate Positions and the final Position, passes the Relevant_Test_File (Requirement 10.9).
5. THE Refactor_Fish test suite SHALL include a property-based test that, for at least 100 generated valid Recordings, including Recordings with zero Blunders and with an empty Best_Line, parsing, then printing, then parsing yields a Recording equivalent to the first parsed Recording (Requirement 16.8).
6. IF a property-based test finds a counterexample, THEN THE Refactor_Fish test suite SHALL fail that test and report the counterexample input and the random seed that reproduces it.
7. WHEN a property-based test is run with a given random seed, THE Refactor_Fish test suite SHALL generate the same sequence of inputs as in any other run with that seed.

### Requirement 25: MCP server (stretch goal)

**User Story:** As a Kiro agent user, I want my agent to request the best refactoring line for a file, so that the agent can use verified refactorings.

#### Acceptance Criteria

1. WHERE the MCP_Server is enabled, THE MCP_Server SHALL expose a tool named `find_best_refactoring_line` that accepts exactly one required input, the path of a Target_File.
2. WHEN the `find_best_refactoring_line` tool is invoked with the path of an existing `.ts` or `.tsx` file, THE MCP_Server SHALL run the Engine on that Target_File and return a result containing the Best_Line as an ordered list of Moves, the Annotation of each Move, and the Metrics of the original Position and of the final Position of the Best_Line.
3. WHERE the MCP_Server is enabled, THE MCP_Server SHALL leave the Target_File and every other file in the project byte-identical before and after every tool invocation.
4. IF the Engine finds no Line with a higher Score than the original Position, THEN THE MCP_Server SHALL return a result with an empty Best_Line and identical before and after Metrics, and SHALL NOT report an error.
5. IF the path is missing, does not exist, or does not have a `.ts` or `.tsx` extension, THEN THE MCP_Server SHALL return an error result naming the invalid path and the reason, and SHALL NOT start the Engine.
6. IF the Engine reports an error, THEN THE MCP_Server SHALL return an error result containing the Engine's error message to the caller, with no partial Best_Line, and SHALL leave the Target_File unchanged.
