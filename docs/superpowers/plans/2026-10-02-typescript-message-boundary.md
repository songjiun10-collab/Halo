# Isolated communication TypeScript migration

## Scope

User approved a separate folder before migrating the communication modules.
Workspace: `/Users/songjiun/.codex/worktrees/ts-message-boundary/Halo`.
Base: `a6c9b75b86caa24cceafc349c3998c62b7cd7f0c`.
The original `/Users/songjiun/Halo` checkout and Claude's concurrent edits are
not overlaid or modified. No commit, push, or merge is part of this migration.

## Implementation

- Author `message-port` and `message-mailbox` under `runtime-src/main/harness`.
- Extend the existing fixed compiler cohort and fixture to five harness modules.
- Keep legacy CommonJS filenames as generated artifacts, with no TS runtime loader.
- Preserve JSON transport, timeout/abort, state mirroring, durable idempotency,
  conversation quota and consumed-message journal semantics.
- Add compiler consumer cases, generated export/error-shape conformance, and
  read-only stale-artifact rejection coverage. Include communication tests in CI.

## Evidence

- RED: the new publisher test rejected the extended fixture with `RUNTIME_CONFIG`
  before the production cohort was extended.
- RED: consumer typecheck rejected the missing communication TS sources.
- GREEN: typecheck and generated-artifact freshness check exit 0.
- Focused tests: 50 passed, 0 failed (port/mailbox, runtime conformance, publisher).
- Independent executable AST comparison against the base JS passes for both
  modules after removing comments/parentheses. Class fields are `declare` only.
- Final `npm test`: 1,414 tests, 1,410 passed, 4 failed, 0 cancelled.
  Failures: `agent-viewport-memory-integration`, `long-horizon-integration`,
  `repeat-journey-verification` (actual Electron timeouts), and
  `concurrent-throughput-benchmark`'s fewer-slots case (peak concurrency 3,
  expected 2). No unrelated product fixes are bundled into this conversion.
  A focused rerun of `concurrent-throughput-benchmark.test.js` passes 5/5;
  this does not erase the full-suite failure or establish its root cause.
- Dependency installation: locked `npm ci --ignore-scripts`; zero known audit
  vulnerabilities at execution time.
- Initial full run hit six Electron installation failures due to simultaneous
  first-use extraction. Partial local `dist` was moved to a recoverable
  `node_modules/electron/dist-install-race-backup`, then the official package
  installer completed. Subsequent real viewport/long-horizon/repeat-journey
  Electron tests still timed out; this is not claimed fixed by the TS conversion.

## Integration boundary

Do not replace generated artifacts in the original running app checkout.
Review and transfer the source/config/tests as one cohort after coordinating
with Claude, stop the target app/service before publication, and repeat
freshness/type/runtime verification on the combined checkout.
