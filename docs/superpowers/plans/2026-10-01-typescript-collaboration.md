# Incremental TypeScript collaboration ledger

## Agreed scope

User requested implementation jointly with the existing Claude session.
First stage keeps CommonJS JavaScript executable filenames and applies strict
JSDoc/checkJs to shared contracts. No authority or journal format changes.

## Ownership

- Claude: shared/harness-contracts.js, shared/task-profile-contracts.js,
  shared/harness-profile.js, shared/capability-registry.js. Runtime validation
  preserved; no blanket any or ts-nocheck suppression.
- Codex: browser package/compiler lockfile, tsconfig.audit.json, npm typecheck,
  migration documentation, independent verification.
- Codex additionally owns test/task-controller-mcp.test.js wait helper after
  notifying Claude; no product controller changes.

## Evidence

- Dedicated TypeScript 6.0.2 and @types/node 24.13.3 installed. npm audit: zero
  known vulnerabilities. Local toolchain reviewed independently: no material
  findings, no frontend dependency resolution, Electron Node major compatible.
- Initial shared strict diagnostic baseline: 154. Claude completed the four-file
  typing; Codex independently ran npm run typecheck successfully (zero
  diagnostics). Focused shared-contract runtime tests pass 16/16.
- Before test correction: whole browser suite 1149 tests, 1147 pass, 2 fail.
  Both failing integration waits used 500 setImmediate iterations, which is
  not an elapsed-time budget.
- Regression: a real 200ms asynchronous event fails the old helper after 10ms.
  Fixed helper polls the condition within a bounded 5s monotonic deadline.
  Focused integration suite passes 12/12; whole browser npm test passes 1150/1150
  after the fix. This run precedes completion of Claude's contract typing.
- Final shared-file snapshot: Codex repeated whole browser npm test, 1150/1150
  pass. All four files are explicitly included in the audit configuration.
- Independent shared-file review: 1152 differential probes across 32 validator
  groups, zero return/error mismatches versus 212a7bd (127 accepted inputs).
- Final review minor (fixed after user continuation): capabilityErrorCode and
  ContractError previously promised a string code, but malformed JSON dependency
  objects with toString:null can produce a TypeError without code. Claude changed
  only annotations to string | undefined, retaining historical rejection.
  Codex's compile-only contract-error.ts fixture failed TS2345 before the fix and
  passes after it; the negative numeric-code case must still be rejected. Test
  fixture @ts-expect-error checks this rejection, not suppresses production code.
- Independent follow-up review confirms the minor is fixed, typecheck passes,
  and the JS runtime source is byte-identical to the previous reviewed snapshot
  after removing only the new type/comment edits.
- A subsequent whole-suite run failed in long-horizon-integration.test.js's
  initialized planner RSS assertion and work-goal-store.test.js's concurrent
  fresh lock reclamation assertion. Both files pass together when rerun (17/17).
  These intermittent failures remain explicitly recorded, not declared fixed by
  this type-only change.
- Final repeated whole browser npm test after the annotation fix: 1150/1150
  pass. Earlier intermittent failures are retained above for reproducibility.

## Remaining

- Actual executable .ts/build migration is a later stage, not claimed complete.
- Frontend missing profile-import.ts test remains outside this typing change.
