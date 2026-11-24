# Engine test utilities

Shared helpers for property tests (Requirement 24). Import from `../test-utils/index.js`.

- Arbitraries: `arbitraryPosition()`, `arbitraryMetrics()`, `arbitraryRecording()`, `arbitraryTestOutcome()`, `arbitraryLine()`.
- Fakes: `FakeTestRunner`, `FakeLLMProvider`, `InMemoryFsSpy`. None of them start Vitest, call an LLM, or touch the disk.

Conventions for property tests:

- Name each file after its property, for example `remove-unused.p6.property.test.ts`, and start it with `// Feature: refactor-fish, Property {n}: {text}`.
- Use `fc.assert(fc.property(...), { numRuns: 100 })`, or the higher minimum the requirement names.

## Reproducing a failure (Requirements 24.6 and 24.7)

On failure, `fc.assert` throws an error that includes the counterexample, the `seed`, and the `path`:

```
Property failed after 12 tests
{ seed: 1234567890, path: "11:0:2", endOnFailure: true }
Counterexample: [...]
```

Re-run with exactly the same inputs by passing both back:

```ts
fc.assert(prop, { seed: 1234567890, path: "11:0:2", endOnFailure: true });
```

`seed` alone replays the same input sequence from the start (Requirement 24.7). Adding `path` jumps straight to the failing case and its shrink steps. Without `path`, omit `endOnFailure`. To get a fixed sequence on every run, set `seed` explicitly. fast-check provides all of this, so no custom seeding exists in the repository.
