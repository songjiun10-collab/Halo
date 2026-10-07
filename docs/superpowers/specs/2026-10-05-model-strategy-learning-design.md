# HALO Model Strategy Learning

Date: 2026-10-05

## Goal

For GPT-6 Luna, let HALO learn bounded planning strategies from successes and failures. Preserve the loop `execution → outcome log → pattern candidate → replay evaluation → human promotion → next-run guidance`, with version history and rollback.

This changes model guidance only. It never trains weights and never changes action policy, permissions, approval, evidence verification, budgets, or task completion rules.

## Data flow

1. **Episode capture:** On terminal completion or pause, host records bounded metadata: model ID, duration profile, terminal outcome, stable pause/failure code, coarse action class (`unknown` when not available), verified criterion count, planner call count, and timestamp. Do not save request text, URL, page text, tool arguments, credentials, screenshots, or raw planner output. Capture is local and gated by the explicit learning setting.
2. **Pattern candidate:** A deterministic extractor groups episodes by `(modelId, duration, stable failure code, coarse action class)`. One incident never creates an active instruction. Candidate content uses a closed strategy ID catalog; no generated markdown, free-form imperative text, code, or permission changes are accepted.
3. **Replay evaluation:** V1 replays the deterministic strategy selector against a small, versioned set of synthetic signatures. It checks whether the fixed catalog mapping matches expected guidance and whether the candidate is narrowly scoped. It does **not** invoke a language model, browser, or real task and does not establish improved model performance. The digest binds the candidate signature, evaluator version, replay-set version, and outcome. Missing/invalid results fail closed; insufficient support is inconclusive.
4. **Human promotion:** A user explicitly promotes an evaluated candidate. The host renders `Agent.md` from the allowlisted strategy IDs for `gpt-6-luna`; it does not accept a caller-supplied markdown body. Other model IDs never consume Luna's policy.
5. **Rollback:** Every promotion is immutable and records parent revision, candidate ID, replay-set version, and metrics. Rollback changes the active revision to an earlier accepted version and is journaled; it does not delete history.

## Strategy boundary

V1 strategies are short, fixed strings in source, selected by IDs. They can guide observation order, retry conservatism, batching of independent known actions, and criterion tracking. They cannot mention or redefine tools, approval, permission, secrets, evidence validity, budget, task goal, or completion authority. Provider prompt integration labels the rendered file as advisory host guidance below the invariant system prompt. The host continues to validate every proposal as before.

## Persistence and privacy

The host owns an encrypted local learning store. Episodes, candidates, replay results, promoted revisions, and rollback records are versioned and size-bounded. Writes use the existing safe-storage and atomic replacement patterns. Corruption, encryption unavailability, or stale revisions disable learning without affecting ordinary task execution. An active policy is immutable once promoted; updates create a new revision.

Learning is opt-in. Turning it off stops capture and guidance but retains existing revisions until the user explicitly clears learning data. The setting is separate from Context Awareness and custom user memory.

## Evaluation contract

- Compare active policy and candidate against the same pinned replay-set revision; the model ID is fixed to GPT-6 Luna for future routing but V1 does not call that model during evaluation.
- Keep candidate evaluation isolated: no live browser, MCP, filesystem tool, credentials, approval queue, or external side effect.
- Reject malformed selector results; require positive target-case improvement with unchanged unrelated-case behavior. Insufficient matching cases are `inconclusive`, never pass.
- Store evaluator version, fixed model ID, case-set version, candidate signature, and digest so selector evaluation is reproducible.
- This replay is a wiring/scope check, not an empirical model-quality gate. A later release must add pinned model-in-the-loop evaluation before claiming behavior improvement.

## Failure behavior

Learning storage and extraction are best-effort side channels. Their failures cannot pause, retry, approve, or complete the browser task. Evaluation failures leave candidate pending. A missing active file uses the built-in guidance. Rollback failure preserves the currently active revision and reports an error. No learning path replays a real browser action.

## V1 exclusions

No cross-model sharing, free-form self-editable instructions, online training, auto-promotion, automatic rollback based on a single live task, raw trace retention, or learning from unverified model claims.
