# TypeScript Runtime Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Codex executes tooling and integration; the existing Claude session owns the four TS source conversions. Steps use checkbox syntax.

**Goal:** Run the four shared contracts from compiled TypeScript without changing their CommonJS runtime interface.

**Architecture:** TS sources are authoritative under runtime-src/shared. A package-local compiler builds into private temporary storage, validates exactly four outputs and either checks or explicitly publishes the legacy shared/*.js artifacts. Default start/test/build only check, never rewrite artifacts.

**Tech Stack:** TypeScript 6.0.2, Node 24 types, CommonJS/ES2022, node:test, existing Electron 44.4.5.

**Spec:** ../specs/2026-10-01-typescript-runtime-phase2-design.md

## Global Constraints

- Exactly four runtime modules; no controller/provider/preload/frontend migration.
- strict, noEmitOnError, allowJs:false; LF; comments retained; no declarations, maps, incremental cache or runtime TS loader.
- Preserve export keys/order, lazy require cycle, Error key order, runtime rejection behavior and journal schemas.
- No blanket any, production ts-ignore/ts-nocheck, credential/config changes or process termination.
- Compilation happens before any output updates; fixed filenames only, no CLI arbitrary roots.
- Only explicit offline build writes artifacts; default build/start/e2e/test check freshness without writing.
- Per-file rename is atomic, the four-file cohort is not. Interrupted publication is detected by check and repaired by a new offline build.
- Commit generated JS with TS sources. Never regenerate before CI freshness checks.

## Review Focus

- Loading the two ends of the lazy cycle in either order must not expose partial exports.
- TS class fields must not change own key order or JSON error serialization.
- Symlinked parent directories, concurrent publishers and changing sources must not publish unexpected files.
- Compile-only tests must consume current TS types, not stale generated JS.
- App/service launches that bypass npm use checked-in artifacts; no runtime compiler or universal freshness guarantee is claimed.

## File ownership

- Claude creates `apps/computer-browser/runtime-src/shared/{harness-contracts,task-profile-contracts,harness-profile,capability-registry}.ts` only.
- Codex creates `tools/build-runtime.js`, `tsconfig.runtime.json`, `test/runtime-build.test.js`, `test/runtime-contract-conformance.test.js` under apps/computer-browser; owns npm/audit/type-test/CI/documentation changes and generated shared/*.js.
- Existing shared JS is the compatibility reference until a verified offline build publishes it. Neither collaborator hand-edits generated JS.

### Task 1: Executable contract compatibility and TS sources

**Interfaces:** Produces the same CommonJS export object as each existing module; all source-only types erase. Consumes the reviewed phase-one runtime at c2ea9fc.

- [ ] Codex writes `runtime-contract-conformance.test.js`: require exactly the four generated artifacts, assert export key lists/order using captured reviewed literals; assert `Object.hasOwn(exports, "__esModule") === false`; assert ContractError/HarnessProfileError own keys and serialized code behavior; load contracts/profile in both orders in fresh processes and invoke actual profile journal validation.
- [ ] Run the conformance cases against current JS to establish the compatibility reference. They should pass. Add a source compilation case that fails because the four TS sources do not yet exist; this is the RED migration test.
- [ ] Claude converts the exact four modules with actual typed parameters/returns and unknown/assertion narrowing. Use `export =` for CommonJS identity, type-only `declare` Error fields, and typed lazy require inside the existing validators. Do not hoist the cycle or normalize malformed inputs.
- [ ] Codex creates `tsconfig.runtime.json`: files list exactly the four TS sources, rootDir runtime-src/shared, strict/CommonJS/ES2022/noEmitOnError/allowJs:false/LF; disable declaration/sourceMap/incremental/importHelpers. Output directory is supplied by the build tool, never the legacy shared directory.
- [ ] Compile to a disposable fixture and run conformance against that output, without rewriting checkout artifacts. Expected: source compilation and conformance pass; existing focused shared runtime tests still pass.

### Task 2: Deterministic build/check tool and failure boundaries

**Interface:** `runRuntimeBuild({projectRoot: string, mode: "check" | "write"}): Promise<void>` exported from `tools/build-runtime.js` for controlled fixture tests. CLI fixes projectRoot relative to its own path; default CLI mode is write, `--check` selects comparison. No CLI root/output/compiler override. Failures carry bounded code/path diagnostics, not source content.

- [ ] Write fixture tests for successful compilation/check; stale or missing artifact rejects without mutation; invalid TS leaves original JS bytes unchanged; two builds match exactly; only expected four JS outputs are accepted. Run: `node --test test/runtime-build.test.js`. Expected initial failure: tool module missing.
- [ ] Implement package-local TypeScript invocation into a fresh 0700 OS-temp directory. Use the reviewed static config and fixed source/output names. Verify file kinds/parents, source/config digests before/after compile, compiler success and exact emitted file set before publication.
- [ ] Add failing tests for source/destination-parent symlinks, a held publisher lock, source changes during compile and unexpected emitted files. Implement fail-closed checks. Fixtures may supply their own trusted projectRoot but the production CLI may not.
- [ ] Write mode acquires a private exclusive lock; compilation succeeds before any replacements. Prepare 0600 sibling temporary files for the exact four outputs, add deterministic generated-file headers, then rename individually. Clean only paths created by this invocation. Lock ownership must be checked before release; stale crash locks require documented manual recovery rather than blind deletion.
- [ ] Add interruption fixture: failure after an individual replacement must leave unaffected artifacts intact, freshness check must report the mismatch, and offline rebuild must restore a matching set. This test verifies detection/repair, not all-files atomicity. No test injection hook belongs in production runtime classes.
- [ ] Run all build/conformance tests; expected: all pass with check-mode fixture snapshots unchanged. Record concurrency and interruption limitations.

### Task 3: Consumer types, npm/CI gates and checked-in output

**Interfaces:** Consumes Task 1 TS sources and Task 2 build CLI. Produces `build:runtime`, `check:runtime`, source-oriented `typecheck` and unchanged runtime import paths.

- [ ] Change audit roots to four TS modules plus type-tests; allowJs:false. Change contract-error.ts to `import contracts = require("../runtime-src/shared/harness-contracts")`. Preserve positive undefined-code and negative numeric-code compiler tests. Run typecheck; expected pass against TS source, independent of checked-in generated JS.
- [ ] Add npm commands: build:runtime invokes tool; check:runtime invokes --check; build runs check then existing frontend build; test runs check then node --test. start and renderer e2e continue through build. Add behavioral test proving stale artifacts stop these commands before downstream execution and do not rewrite files.
- [ ] Add Node 24 browser-check job to tests.yml without altering Python/Rust jobs: locked npm install with scripts disabled, check:runtime, typecheck, selected shared/build/conformance Node tests. Do not run Electron on headless Linux or claim hosted CI succeeded before observing it.
  Verification command: `node --test test/harness-contracts.test.js test/task-profile-contracts.test.js test/harness-profile.test.js test/runtime-build.test.js test/runtime-contract-conformance.test.js`. Expected: all selected tests pass without an Electron display.
- [ ] Verify app/background service is stopped before generating the four checkout artifacts; do not kill user processes implicitly. If active, request the specific shutdown and continue disposable fixture checks meanwhile. Run explicit build:runtime, check:runtime and typecheck; expected success and only four JS outputs updated.
- [ ] Update TYPESCRIPT-MIGRATION.md with source ownership, generated artifacts, offline writing, stale lock recovery, direct Electron/LaunchAgent preparation boundary and changed stack line numbers.
- [ ] Run `npm test` and record all totals/failures. Run `npm run build`; run the existing real Electron long-horizon integration test against generated artifacts. Report frontend missing profile-import.ts test separately if still present; do not delete it to make unrelated tests green.
  Real-runtime command: `node --test test/long-horizon-integration.test.js`. Expected: the real Electron/planner/approver journey completes without replay, with measured memory; record actual peak and any sampling failure rather than infer success from unit tests.
- [ ] Independently review source/compiled behavior against c2ea9fc, then commit source/config/tooling/test/CI/generated files together. Push only within the user's existing authorized branch workflow; no merge or release claim.

## Handoff and acceptance

User approved the written spec on the current turn. Implementation waits for review of this plan; preserve the already-selected Codex + existing Claude execution method.
Final acceptance requires successful TS compilation, read-only freshness checking, preserved contract behavior, real generated-JS execution, and explicit reporting of intermittent/environment-dependent test failures.
