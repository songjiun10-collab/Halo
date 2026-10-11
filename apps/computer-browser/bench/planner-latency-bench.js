// Real NVIDIA planner-turn latency benchmark.
//
// Purpose: decompose agent turn time. The pilot's real recorded action times
// (p50 1482ms, p95 9385ms over 28 actions) cover dispatch only. This measures
// the other half -- the planner round trip -- through the REAL
// NvidiaPlannerBridge, so "harness" vs "model" can be separated and the model
// choice optimized on numbers instead of intuition.
//
// Fidelity note: context.goal is the REAL recorded goal from the pilot store
// (task accfbe54...): "Find the list of neighborhood maps for Brooklyn on
// new.mta.info." The observation is RECONSTRUCTED -- the store kept goal,
// actions and evidence but not the planner context, and screenMap/elements are
// not recoverable. So absolute token counts are representative, not identical to
// the pilot's.

const path = require("node:path");
const fs = require("node:fs");
const { createKeychainStorage } = require("../main/harness/chromium-keychain");
const { ApiKeyStore } = require("../main/harness/api-key-store");
const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
const { NVIDIA_MODELS, DEFAULT_NVIDIA_MODEL, setDiscoveredNvidiaModels, nvidiaReasoningKwargs } = require("../main/harness/providers/nvidia-models");

const ROOT = path.join(process.env.HOME, "Library/Application Support/halo-computer-browser/harness-data");
const MODELS = (process.env.MODELS || [
  DEFAULT_NVIDIA_MODEL,
  "deepseek-ai/deepseek-v4.1-flash",
  "moonshotai/kimi-k3",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const REPS = Number(process.env.REPS || 3);
// nvidia-models.js nvidiaReasoningKwargs only emits {thinking:true,...} for
// deepseek-v4* at high/xhigh/max/ultra. At medium it returns null, i.e.
// non-thinking. EFFORT therefore decides whether DeepSeek actually reasons.
const EFFORT = process.env.EFFORT || "medium";

const TASK_ID = "accfbe54-5697-4afc-8666-7da5254754f4";

function buildContext() {
  return {
    taskId: TASK_ID,
    goalVersion: 1,
    goal: {
      originalRequest: "Find the list of neighborhood maps for Brooklyn on new.mta.info.",
      criteria: [{ id: "benchmark", text: "Find the list of neighborhood maps for Brooklyn on new.mta.info.", required: true, verification: "user" }],
    },
    observation: {
      id: "obs-reconstructed-1",
      url: "https://www.mta.info/maps",
      title: "mta.info/maps",
      // Reconstructed text-mode screen map in the shape the harness emits.
      screenMap: [
        "# Neighborhood maps",
        "The MTA has 5 neighborhood maps: Brooklyn, Manhattan, Queens, Staten Island, and the Bronx.",
        "## Brooklyn",
        "- link \"Brooklyn\"",
        "## Manhattan",
        "- link \"Manhattan\"",
      ],
      elements: [
        { id: "e1", role: "link", name: "Brooklyn", tag: "a" },
        { id: "e2", role: "link", name: "Manhattan", tag: "a" },
      ],
      computerUse: { mode: "text" },
    },
    progress: {
      plannerEffort: EFFORT,
      maxActionsPerProposal: 4,
      criteriaStatus: { benchmark: "pending" },
      remaining: { actions: 47, plannerCalls: 22, activeMs: 170000 },
    },
  };
}

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

(async () => {
  const store = new ApiKeyStore({ storageRoot: ROOT, safeStorage: createKeychainStorage() });
  await store.load();
  const key = store.env().NVIDIA_API_KEY;
  if (!key) { console.error("NVIDIA_API_KEY not present in the key store"); process.exit(1); }

  // Let any catalog id be selectable so we can benchmark beyond the built-in 5.
  const modelsRes = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000),
  });
  const catalog = (await modelsRes.json()).data?.map((d) => d.id) || [];
  setDiscoveredNvidiaModels(catalog);

  const context = buildContext();
  const rows = [];
  for (const model of MODELS) {
    for (let rep = 1; rep <= REPS; rep++) {
      const bridge = new NvidiaPlannerBridge({ apiKey: key, model, timeoutMs: 55000 });
      const t0 = Date.now();
      try {
        const proposal = await bridge.start(context);
        const ms = Date.now() - t0;
        const usage = bridge.takeUsage() || {};
        rows.push({ model, rep, ok: true, ms, kind: proposal.kind, actions: proposal.actions?.length,
          inTok: usage.inputTokens, outTok: usage.outputTokens });
        console.log(`  ${model} r${rep}: ${ms}ms ok kind=${proposal.kind} in=${usage.inputTokens} out=${usage.outputTokens}`);
      } catch (error) {
        const ms = Date.now() - t0;
        rows.push({ model, rep, ok: false, ms, code: error.code || error.message });
        console.log(`  ${model} r${rep}: ${ms}ms FAIL ${error.code || error.message}`);
      } finally {
        await bridge.close();
      }
    }
  }

  console.log("\n=== 요약 (실측 planner round trip) ===");
  console.log(`effort=${EFFORT}  (reasoning kwargs: ${MODELS.map((m) => `${m.split("/").pop()}=${JSON.stringify(nvidiaReasoningKwargs(m, EFFORT))}`).join("  ")})`);
  for (const model of MODELS) {
    const ok = rows.filter((r) => r.model === model && r.ok);
    const bad = rows.filter((r) => r.model === model && !r.ok);
    const kw = JSON.stringify(nvidiaReasoningKwargs(model, EFFORT));
    if (!ok.length) { console.log(`${model} [${kw}]: 전부 실패 (${bad.map((b) => b.code).join(",")})`); continue; }
    const ms = ok.map((r) => r.ms);
    const avgIn = Math.round(ok.reduce((a, r) => a + (r.inTok || 0), 0) / ok.length);
    const avgOut = Math.round(ok.reduce((a, r) => a + (r.outTok || 0), 0) / ok.length);
    console.log(`${model} [${kw}]`);
    console.log(`  성공 ${ok.length}/${ok.length + bad.length}  p50=${pct(ms, 0.5)}ms  max=${Math.max(...ms)}ms  평균 in=${avgIn} out=${avgOut} tok`);
  }
  fs.writeFileSync("/private/var/folders/x0/gp37ndd96_ddxtf0fn0t6kk00000gn/T/opencode/planner-latency.json", JSON.stringify(rows, null, 2));
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });