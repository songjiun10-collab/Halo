# HALO Model Strategy Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an opt-in Luna-only strategy learning loop with bounded episode capture, deterministic candidate grouping, replay evaluation, explicit promotion, and rollback.

**Architecture:** A strict TypeScript learning core and encrypted host store own the versioned records. Host lifecycle hooks capture metadata only; a closed strategy catalog renders the active Agent.md into Luna planner context. Candidate evaluation uses isolated fixtures and never dispatches browser actions.

**Tech Stack:** TypeScript 6.0.2, existing CommonJS runtime compiler cohorts, Electron safeStorage, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-05-model-strategy-learning-design.md`

## Global Constraints

- Learning defaults off and remains independent from Context Awareness and custom memory.
- Never persist prompts, page content, URLs, tool arguments, screenshots, secrets, or raw model output.
- The only strategy IDs are the source-defined catalog; reject arbitrary instructions or markdown bodies.
- Only GPT-6 Luna consumes this policy in V1.
- Promotion always requires user approval after a passing replay evaluation.
- Learning never changes permission, policy, approval, evidence, budgets, or terminal-state decisions.
- Evaluation runs without live browser, MCP, credentials, or external side effects.
- Preserve all existing dirty work; do not commit or push.

## Review Focus

- Malformed or oversized records: fail closed without task impact; test corrupt store records.
- One failure: must not create active guidance; test minimum evidence threshold.
- Candidate with safety/criterion regression: cannot pass or promote; test each guard metric.
- Stale or model-mismatched evaluation: cannot promote; test revision/model binding.
- Rollback after multiple promotions: history remains and active policy returns to the exact prior rendered file; test round trip.

## File Structure

- `runtime-src/main/harness/strategy-learning.ts`: pure schemas, grouping, evaluation gate, Agent.md renderer.
- `main/harness/strategy-learning-store.js`: encrypted bounded records and immutable revisions.
- `main/harness/task-host.js` / `main/index.js`: lifecycle capture and service ownership.
- `main/harness/providers/model-prompt-guidance.js`: append the active rendered policy for Luna only.
- `main/harness/host-settings.js`, IPC/preload/control API, renderer settings: opt-in toggle and candidate evaluate/promote/rollback controls.
- `test/strategy-learning.test.js` and focused host/UI tests: lifecycle and boundary regression.
- Runtime compiler config/build fixtures/conformance: generated CommonJS boundary.

## Tasks

1. Add pure-learning tests, then strict TypeScript core for episode validation, repeated-pattern candidates, strategy ID catalog, replay non-regression gate, and deterministic Agent.md rendering.
2. Add encrypted store tests, then bounded persistence with revision history, optimistic parent revision, explicit promote, rollback, and clearing semantics.
3. Add host-setting/API tests and wire opt-in capture from terminal task snapshots using only stable metadata; prove logging failures do not alter task state.
4. Add provider prompt tests and inject active Agent.md only for GPT-6 Luna in the advisory section.
5. Add renderer controls for enabling capture, reviewing candidate evidence/replay results, explicit promote, and rollback; keep all controls unavailable when learning is off.
6. Extend TypeScript compiler cohort, generated artifact conformance, type fixtures, and migration inventory.
7. Run focused tests, typecheck, generated freshness check, then the full app suite. Inspect the combined diff and confirm no raw episode content is persisted.

Execution: native implementation by the current Codex session. No subagents, commit, or push.
