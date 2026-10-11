# Claude API-key models (design, not implemented)

Status: draft for review. No code changes accompany this document.

## Problem

The Claude app's subscription menu does not offer seven older models that
only run with an API key (Anthropic API, or AWS Bedrock, which is the same
API-key route): Opus 4.5, Opus 4.1, Opus 4, Sonnet 4.5, Sonnet 4, Sonnet 3.7,
Haiku 3.5. Halo's Claude planner runs the local `claude` CLI on the
subscription login, so these models cannot run. They are therefore kept out of
the allowlist and every picker (`CLAUDE_API_MODELS` in
`main/harness/providers/claude-models.js`; tiers stay in `model-tiers.ts`).

This document describes how to let them run, without weakening the isolation
the current bridge guarantees.

## Constraints that must keep holding

1. `buildEnv` in `claude-code-bridge.js` copies only `PATH, HOME, USER, LANG,
   TZ, TMPDIR` into the CLI child. No `ANTHROPIC_*`, `AWS_*` or ambient
   process-env credential may reach it. This is a deliberate allowlist.
2. A key never reaches the renderer; status reports presence only
   (`api-key-store.js`).
3. The host re-validates every model id; page text, model output and the
   renderer cannot choose a `--model` argument.

## Design

### Key storage (reuse, do not invent)

Add one provider id `claude` to `KEY_ENV` in `api-key-store.js`, mapped to
`ANTHROPIC_API_KEY`. The key is encrypted with the OS keychain like the
Gemini, Cursor and NVIDIA keys, set and cleared through the existing
`setApiKey` / `clearApiKey` / `apiKeyStatus` host calls and the Settings
screen's key field.

### Getting the key to the CLI without opening the allowlist

- `plannerProviderEnv` returns `HALO_CLAUDE_API_KEY` (a Halo-specific name)
  for the Claude worker, taken only from the key store, never from ambient
  `process.env`.
- The worker hands it to `ClaudeCodeBridge` as an explicit constructor
  argument. The bridge sets `ANTHROPIC_API_KEY` in the child env from that
  argument only. `ENV_ALLOWLIST` stays as is; the key is a separate,
  explicitly passed value, so a stray `ANTHROPIC_API_KEY` in Halo's own
  environment is still dropped.

### Passing the key only when it is needed

The CLI prefers `ANTHROPIC_API_KEY` over the subscription login whenever it is
set, which would silently move every task onto API billing. The bridge
therefore adds the key to the child env only when the selected model is one of
the API-only models. Subscription models keep running on the login.

### Allowlist and visibility

The API-only models join the allowlist dynamically, the same way NVIDIA
catalog models are merged (`setDiscoveredNvidiaModels`): when a `claude` key is
registered the host exposes them; when it is cleared they disappear again and a
saved selection falls back to the default model. The frontend mirror reads the
list from the host instead of hard-coding it for these seven.

### Bedrock (out of scope here)

Bedrock needs several values (access key, secret, region,
`CLAUDE_CODE_USE_BEDROCK`) and different model ids. It is a separate follow-up
with its own store entry; this design covers the single Anthropic API key
only.

## Open questions

1. Should registering a key also surface newer models that are API-only, or
   only the seven above?
2. Should the model picker label API-only models ("API key") so cost differs
   visibly from subscription use?
3. Does a clear key mid-task need to abort a running task on an API-only model,
   or is "applies to the next task" enough? Proposed: next task.

## Test plan

- Key store: `claude` provider round-trips and reports presence only.
- Bridge: `ANTHROPIC_API_KEY` is absent from the child env for subscription
  models even when passed, present for an API-only model; an ambient
  `ANTHROPIC_API_KEY` is never forwarded.
- Host: API-only ids rejected without a key, accepted with one, rejected again
  after clearing.
- Frontend: picker lists the seven only when the host reports the key.
