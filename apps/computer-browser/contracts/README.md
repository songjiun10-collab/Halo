# HALO contract conformance corpus

Language-neutral test data for the durable formats and pure functions that a non-JS coordinator (see
`docs/superpowers/specs/2026-09-29-rust-coordinator-boundary-design.md`) must reproduce exactly.

`conformance/<kind>.json` is `{ "kind": "...", "cases": [...] }`.

Validation kinds (`goal_spec`, `journal_event`, `checkpoint_envelope`, `evidence`, `proposal_envelope`,
`message_envelope`, `routine_definition`, `schedule_input`, `schedule_record`): each case is
`{ name, valid, value, code?, pad? }`.

- `valid: true` - the validator must accept `value`.
- `valid: false` - the validator must reject `value` with error code `code`. Codes are part of the contract.
- `pad` - `{ path, char, length }`: before validating, set the dotted `path` inside `value` to `char` repeated
  `length` times. Used for size-limit cases so the corpus stays small.

`schedule_evaluate`: each case is `{ name, input: { record, nowMs }, expected }` where `expected` is the exact
result of `evaluateSchedule(record, nowMs)`.

## Rules

- The JS validators in `shared/*-contracts.js` are the reference until a port passes every file here.
- `test/contract-conformance.test.js` runs every case against the JS reference. Change a validator, change the
  corpus in the same commit.
- Add a case for every new field, enum value, bound, or rejection rule.
