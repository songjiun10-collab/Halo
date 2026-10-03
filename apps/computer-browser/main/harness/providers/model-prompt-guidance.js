"use strict";

// Host-owned profiles are selected only from provider/model allowlists. They
// influence planning style, never permissions, policy, schemas, evidence, or
// approval. Keep them short because the prompt is sent on every planner turn.
const CLAUDE = Object.freeze({
  "claude-fable-5-1": Object.freeze({
    base: "Fable 5.1 is designed for long-horizon agentic work. Carry the requested task through the host's criterion checklist: propose the next action now instead of ending with a plan or asking whether to continue. HALO still pauses at its human approval gate, and you must not cross it.",
    low: "At low effort, verify claims against the current observation and available evidence rather than relying on remembered or unstated page information.",
    medium: "Batch independent actions whose targets are already known into this proposal up to the host limit; never batch actions whose next target depends on an intervening result.",
    high: "Batch independent, already-grounded actions up to the host limit. Keep the proposal tied to the requested criteria; do not add adjacent tasks.",
    xhigh: "At xhigh, keep proposals bounded and grounded: batch only independent known actions, and do not add review or exploration beyond the criteria.",
    max: "At max, keep proposals bounded and grounded: batch only independent known actions, and do not add review or exploration beyond the criteria.",
    ultra: "At the highest available effort, keep proposals bounded and grounded: batch only independent known actions, and do not add review or exploration beyond the criteria.",
  }),
  "claude-sonnet-5-5": Object.freeze({
    base: "Sonnet 5.5 is effort-sensitive. Keep browser work bounded to the stated criteria. When the next safe, supported action is clear, propose it instead of checking in for reassurance; ask only for a required missing choice or a genuine blocker. Do not broaden the task.",
    low: "At low effort, do not stop after part of a multi-criterion task when another safe action is clear. Still collect required evidence before finish.",
    medium: "At medium effort, continue well-specified criteria without asking permission for ordinary reversible navigation or observation. Do not infer permission for consequential actions.",
    high: "At high effort, spend reasoning on the stated criteria, not extra browsing; stop once host-verifiable evidence is sufficient.",
    xhigh: "At xhigh effort, be especially strict about scope: no exploratory side trips or extra criteria; stop when requested criteria have evidence.",
    max: "At max effort, be especially strict about scope: no exploratory side trips or extra criteria; stop when requested criteria have evidence.",
    ultra: "At the highest available effort, be especially strict about scope: no exploratory side trips or extra criteria; stop when requested criteria have evidence.",
  }),
  "claude-opus-5-5": Object.freeze({
    base: "Opus 5.5 can sustain multistep work and may emit progress-like turns before completion. Treat only host-recorded criterion evidence as completion: if criteria remain and a supported action can advance them, propose it; never treat status or a partial result as finish. The host controls continuation and risky-action approval.",
    low: "At low effort, keep the proposal economical without skipping any criterion's required evidence.",
    medium: "At medium effort, use the normal multistep path and avoid escalating beyond the user's criteria.",
    high: "At high effort, apply extra capacity to the requested criteria, not unrequested exploration or review.",
    xhigh: "At xhigh effort, tie every proposal to a criterion; do not start extra review rounds or expand scope.",
    max: "At max effort, tie every proposal to a criterion; do not start extra review rounds or expand scope.",
    ultra: "At the highest available effort, tie every proposal to a criterion; do not start extra review rounds or expand scope.",
  }),
  "claude-haiku-4-5-20251001": Object.freeze({
    base: "Haiku 4.5 is HALO's latency-oriented profile. Prefer a direct, low-token proposal grounded in the current observation; do not spend calls re-reading known state. Never trade away a required criterion, evidence check, or human approval for speed.",
    low: "At low effort, choose one clear next step instead of constructing a speculative multi-step route; use the next host observation to resolve uncertainty.",
    medium: "At medium effort, batch only independent actions already supported by the observation; keep dependent steps for the next turn.",
    high: "At high effort, use extra reasoning only for the criterion's actual ambiguity; keep the action path short and verify with host evidence.",
    xhigh: "At xhigh, do not add speculative exploration; use extra effort to select among evidence-supported options, then keep the proposal short.",
    max: "At max, do not add speculative exploration; use extra effort to select among evidence-supported options, then keep the proposal short.",
    ultra: "At the highest available effort, do not add speculative exploration; use extra effort to select among evidence-supported options, then keep the proposal short.",
  }),
  "claude-3-5-haiku-20241022": Object.freeze({
    base: "Legacy Haiku 3.5 profile: keep the proposal to a direct action grounded in the latest observation. Do not infer unsupported controls or skip host-required evidence.",
    low: "Choose one unambiguous next action; defer uncertain follow-up actions until the next observation.",
    medium: "Batch only independent actions with already-known targets; defer dependent actions until the next observation.",
    high: "Use extra effort to resolve the current ambiguity, not to broaden scope; return the shortest proposal that advances a criterion.",
    xhigh: "Keep the proposal narrowly tied to a criterion and grounded in current evidence.",
    max: "Keep the proposal narrowly tied to a criterion and grounded in current evidence.",
    ultra: "Keep the proposal narrowly tied to a criterion and grounded in current evidence.",
  }),
});

const CODEX = Object.freeze({
  "gpt-6-astra": "GPT-6 Astra is selected for demanding work: resolve ambiguity from supplied observations before acting, and reduce uncertainty when that is necessary to meet a criterion. Do not add actions merely to be exhaustive.",
  "gpt-6.1-sol": "GPT-6.1 Sol is the workhorse profile: batch independent, already-justified browser actions up to the host limit; defer dependent actions until a fresh observation.",
  "gpt-6-sol": "GPT-6 Sol is the workhorse profile: batch independent, already-justified browser actions up to the host limit; defer dependent actions until a fresh observation.",
  "gpt-6-luna": "GPT-6 Luna is optimized for easier, faster work: choose the shortest sufficient route and avoid optional exploration, while collecting every required criterion's evidence.",
  "gpt-5.6-sol": "Use the workhorse route: batch independent, already-justified browser actions up to the host limit; defer dependent actions until a fresh observation.",
  "gpt-5.6-terra": "Use the balanced route for straightforward tasks: prefer the shortest supported action sequence and verify each stated criterion.",
  "gpt-5.6-luna": "Use the fast route for easier tasks: choose the shortest sufficient path without skipping required evidence.",
  "gpt-5.5": "Use this coding-agent model as a constrained browser planner: propose only supported browser actions grounded in the latest observation; do not infer tools or permissions HALO has not exposed.",
});

const NVIDIA = Object.freeze({
  "deepseek-ai/deepseek-v4-flash": "DeepSeek V4 Flash is the fast option in HALO's NIM catalog: prefer a direct proposal and batch only actions with already-known targets and effects; skip optional exploration.",
  "deepseek-ai/deepseek-v4-pro": "DeepSeek V4 Pro is the higher-capability reasoning option in HALO's NIM catalog: resolve multi-criterion dependencies from current evidence, then emit only the next bounded HALO proposal.",
  "moonshotai/kimi-k3": "Kimi K3 supports long-context agentic work: use durable criteria and the current observation as working state; do not restate or re-derive recorded history unless a criterion needs it.",
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super is the agentic-work option: ground each bounded proposal in the goal and current observation, and distinguish action dispatch from host-verified completion.",
});

const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
function getModelPromptGuidance(provider, model, effort = "medium") {
  if (provider === "claude") {
    const profile = CLAUDE[model];
    if (!profile) return null;
    return `${profile.base} ${profile[EFFORTS.includes(effort) ? effort : "medium"]}`;
  }
  if (provider === "codex") return CODEX[model] || null;
  if (provider === "nvidia") return NVIDIA[model] || null;
  // Antigravity does not pin a Gemini model; Cursor routes using "auto".
  return null;
}

module.exports = { getModelPromptGuidance };
