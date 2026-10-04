# Planner model prompt guidance

HALO has one host-owned planner contract. Static model guidance is combined
with bounded, per-turn task and user-style adaptation, never a policy source. It cannot change the
user's goal, permissions, approval requirements, evidence rules, action shapes,
or validator. Model output remains untrusted and must pass the existing schema
and host checks. Guidance never asks for private chain-of-thought.

## Profiles

Each pinned model ID has a distinct profile in `main/harness/providers/model-prompt-guidance.js`.
Fable 5.1 is tuned for long-horizon completion and batching independent,
already-grounded actions; its low-effort profile explicitly favors checking
the current observation over relying on memory. Haiku 4.5 is tuned for a short,
low-latency action path, with uncertainty deferred to the next host observation
instead of speculative multi-step planning. Legacy Haiku 3.5 gets a narrower
compatibility profile, not Haiku 4.5's capability claims.
Claude Opus 5.5 and Sonnet 5.5 are additionally conditioned on the host's
planner effort: Sonnet's low/medium profile avoids unnecessary check-ins while
preserving evidence and human approval; its high/max profiles curb scope creep.
Opus's profile distinguishes progress-like turns from host-verified completion
and prevents high effort from creating extra review work.

Codex Astra is steered toward resolving uncertainty only when it matters to a
criterion; Sol toward batching independent known actions; Luna toward the
shortest sufficient path. The NVIDIA allowlist differentiates Flash (direct,
low-latency proposals), Pro (multi-criterion dependencies), Kimi K3
(long-context/durable state), and Nemotron (agentic action vs verified
completion). These distinctions are prompt heuristics based on catalog/model
descriptions, not a claim that each has a vendor-validated HALO prompt recipe.

Antigravity's Gemini provider and Cursor Auto receive no model-specific
profile: the exact model/version is not pinned by HALO.

Profiles are selected only from host-owned allowlists. Task text, webpage data,
playbooks, and planner output cannot choose or modify them. Profiles are
deliberately short; all providers receive the same core protocol. This is an
initial prompt adaptation, not a claim of benchmark improvement. It should be
kept only if measured task success, policy compliance, latency, and token cost
support it.

## Adaptation to usage and context

`context-builder.js` recomputes `plannerAdaptation` every turn from the current
host harness profile, MCP availability, immutable user goal/amendments, criterion
progress, and origin-filtered local memory. The packet is at most 1 KiB. It is
optional and is added only after goals, observations, pending messages and team
notes have received space inside the existing 64 KiB context cap. A missing
packet leaves the normal model profile and protocol intact.

Fast/short tasks use a short action path; long tasks retain their durable
completion checklist. Travel/multi-source requests get source identity/date
cross-checks and real tool discovery through the existing MCP search/describe/
propose flow. A host clock timestamp and time zone support interpreting relative
dates. Original booking QR assets must be preserved. Artifact creation must use
an actual described tool and produce evidence; absent computer/file/export
capabilities remain blockers. No new connector, image renderer, or OS computer
control is implemented by this prompt adaptation.

Personalization uses the existing local custom-memory editor and storage. Save
one exact line per entry:

```text
HALO_PREF: planning=concise
HALO_PREF: planning=balanced
HALO_PREF: planning=thorough
HALO_PREF: batching=single
HALO_PREF: batching=independent
```

Choose one value for each key, rather than saving every example. Global memories
have `origin: null`; a preference scoped to the current page's origin overrides
the global preference. Conflicting values at the same scope fall back to
balanced planning / independent batching. Fast mode selects concise planning,
and the user's goal always retains its full requirements. Changes or deletions
take effect on the next rebuilt planner context. Preferences are re-evaluated
locally; this feature does not learn or persist inferred habits from activity
logs.

Only exact, allowlisted preference lines become enums. Free-form memory stays
in `untrusted_user_memory`; page contents, MCP output, model summaries and room
transcripts cannot alter the adaptation. All prompts emit fixed host-authored
guidance for those enums rather than inserting arbitrary preference text. Room
turns receive discussion style only, preserving the `say`/`pass`/`propose_task`
protocol instead of browser action/finish instructions.

## Basis and limits

The Karpathy-style skill emphasizes explicit assumptions, minimal sufficient
work, surgical scope, and verifiable completion. HALO adapts only the relevant
planning behaviors; coding-specific instructions are not transplanted into a
browser planner.

Anthropic's Fable 5.1 guidance discusses long-horizon completion, batching
independent tool calls, and lower search/retrieval at low effort. HALO adapts
these specifically to browser proposals without adding bypasses around approval.
Anthropic describes Haiku 4.5 as the fastest model with near-frontier
intelligence and recommends it for latency-sensitive work; the short-proposal
profile follows that tradeoff but does not reduce required evidence.
Anthropic's Sonnet 5.5 guidance discusses effort/latency tradeoffs, early
check-ins at lower effort, and scope control. Opus 5.5's guide emphasizes
host-maintained completion criteria for unattended turns and effort calibration.
OpenAI's reasoning guidance favors clear goals, constraints, and output formats
without prescribing every reasoning step. These profiles do not change vendor
effort parameters or request protocols. HALO still takes the selected effort
from trusted host context; it only changes the short model-specific prompt
delta. No success or latency improvement is claimed before evaluation.

Sources:

- [Karpathy skills](https://github.com/multica-ai/andrej-karpathy-skills)
- [Anthropic Fable 5.1 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
- [Anthropic Haiku 4.5 model guidance](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
- [Anthropic latency guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)
- [Anthropic Sonnet 5.5 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
- [Anthropic prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview)
- [Anthropic Opus 5.5 prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [NVIDIA Kimi K3 model card](https://build.nvidia.com/moonshotai/kimi-k3/modelcard)
- [NVIDIA NIM inference references](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer)
