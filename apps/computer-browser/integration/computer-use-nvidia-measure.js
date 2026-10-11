"use strict";

// TEMPORARY measurement runner. Drives the REAL harness end to end in
// computer-use mode against a local fixture, with a hosted NVIDIA planner, and
// records per-call provider usage, prompt/context bytes, latency, and the
// proposed action kinds.
//
//   node integration/computer-use-nvidia-measure.js --check
//   node integration/computer-use-nvidia-measure.js --dry-run     # scripted planner, no quota
//   node integration/computer-use-nvidia-measure.js               # real NVIDIA
//
// Options: --model <id> (default nemotron), --max-calls <n>, --out <file>
//
// Key resolution: NVIDIA_API_KEY first, then the key registered in HALO
// Settings (decrypted through the app's own keychain module; never printed).

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { createKeychainStorage } = require("../main/harness/chromium-keychain");
const { ApiKeyStore } = require("../main/harness/api-key-store");
const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
const { DEFAULT_NVIDIA_MODEL } = require("../main/harness/providers/nvidia-models");
const { getModelPromptGuidance } = require("../main/harness/providers/model-prompt-guidance");
const { buildPrompt } = require("../main/harness/providers/claude-code-bridge");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport, createCdpView } = require("../main/harness/cdp-web-contents");
const { AgentViewportHost } = require("../main/harness/agent-viewport-host");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const CHROMIUM = process.env.HALO_CHROMIUM
  || path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell");
const ARGS = process.argv.slice(2);
const has = (flag) => ARGS.includes(flag);
const value = (flag, fallback) => ARGS.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback;
const MODEL = value("--model", DEFAULT_NVIDIA_MODEL);
const MAX_CALLS = Number(value("--max-calls", "8"));
const OUT = value("--out", path.resolve(__dirname, "../../../artifacts/computer-use-nvidia/results.json"));
const GOAL_TEMPLATE = "In the Support Console at __URL__, search for refunds and report the ticket id shown in the results.";

// A CU-friendly fixture: a labeled field, a labeled button, and a result the
// planner can only see after the interaction succeeded.
function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Support Console</title>
  <style>body{font:14px -apple-system,sans-serif;margin:24px}input{padding:6px;width:220px}button{padding:6px 12px;margin-left:6px}#out{margin-top:18px;font-size:15px}</style>
  </head><body>
  <h1>Support Console</h1>
  <label for="q">Search tickets</label><br>
  <input id="q" placeholder="Search tickets">
  <button id="go">Search</button>
  <div id="out">No search yet.</div>
  <script>
    document.getElementById("go").addEventListener("click", () => {
      const q = document.getElementById("q").value.trim().toLowerCase();
      document.getElementById("out").textContent = q.includes("refund")
        ? "Ticket 4821 refund requested"
        : "No matching tickets";
    });
  </script>
  </body></html>`;
}

async function resolveApiKey() {
  const fromEnv = typeof process.env.NVIDIA_API_KEY === "string" ? process.env.NVIDIA_API_KEY.trim() : "";
  if (fromEnv) return { key: fromEnv, source: "NVIDIA_API_KEY" };
  const storageRoot = path.join(os.homedir(), "Library", "Application Support", "halo-computer-browser", "harness-data");
  const store = new ApiKeyStore({ storageRoot, safeStorage: createKeychainStorage() });
  await store.load();
  const key = store.env().NVIDIA_API_KEY ?? "";
  return { key, source: key ? "HALO Settings keychain" : "not registered" };
}

// Scripted planner for the dry run: navigate, type, click -- one interaction
// per proposal exactly as the harness contract requires -- then finish.
// Exercises the exact controller plumbing.
function scriptedPlanner(base) {
  let turn = 0;
  return {
    next: async (context) => {
      turn += 1;
      const baseOut = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id, criterionIds: [] };
      const elements = context.observation?.elements ?? [];
      if (turn === 1) return { ...baseOut, kind: "actions", actions: [{ type: "navigate", url: `${base}/` }] };
      if (turn === 2) return { ...baseOut, kind: "actions", actions: [{ type: "type", elementId: elements.find((e) => e.role === "textbox")?.elementId ?? "2", text: "refund" }] };
      if (turn === 3) return { ...baseOut, kind: "actions", actions: [{ type: "click", elementId: elements.find((e) => e.role === "button")?.elementId ?? "3" }] };
      return { ...baseOut, kind: "need_user", reason: "Search completed; the console reports the ticket result." };
    },
    close: async () => undefined,
  };
}

(async () => {
  if (has("--check")) {
    const { key, source } = await resolveApiKey();
    console.log(`key source : ${source}${key ? ` (${key.length} chars, not printed)` : ""}`);
    console.log(`model      : ${MODEL}${has("--dry-run") ? " (dry run: model not called)" : ""}`);
    console.log(`browser    : ${CHROMIUM} ${fsSync.existsSync(CHROMIUM) ? "(present)" : "(MISSING)"}`);
    if (!key && !has("--dry-run")) process.exitCode = 1;
    return;
  }

  // ---- fixture --------------------------------------------------------------
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const GOAL = GOAL_TEMPLATE.replace("__URL__", `${base}/`);

  // ---- key + planner --------------------------------------------------------
  let planner;
  let keySource = "none";
  if (has("--dry-run")) {
    planner = scriptedPlanner(base);
  } else {
    const resolved = await resolveApiKey();
    if (!resolved.key) throw new Error(`no NVIDIA key available (${resolved.source})`);
    keySource = resolved.source;
    const bridge = new NvidiaPlannerBridge({ apiKey: resolved.key, model: MODEL });
    const calls = [];
    planner = {
      calls,
      next: async (context, options) => {
        const call = calls.length + 1;
        const guidance = getModelPromptGuidance("nvidia", MODEL, context.progress?.plannerEffort);
        const promptBytes = Buffer.byteLength(buildPrompt(context, guidance), "utf8");
        const contextBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
        const started = performance.now();
        const proposal = await bridge.start(context, options);
        const wallMs = Math.round(performance.now() - started);
        const usage = bridge.takeUsage();
        const elements = Array.isArray(context.observation?.elements)
          ? context.observation.elements.map((e) => ({ id: e.elementId, role: e.role, name: String(e.name ?? "").slice(0, 30), value: e.value ?? undefined }))
          : [];
        calls.push({
          call, promptBytes, contextBytes, wallMs, usage,
          observationUrl: context.observation?.url ?? null,
          computerUse: context.observation?.computerUse?.mode ?? null,
          screenMapBytes: Buffer.byteLength(String(context.observation?.screenMap ?? ""), "utf8"),
          elementCount: elements.length,
          elements,
          lastAction: context.progress?.lastAction ?? null,
          kind: proposal?.kind ?? null,
          actionTypes: Array.isArray(proposal?.actions) ? proposal.actions.map((a) => a.type) : [],
          actions: Array.isArray(proposal?.actions) ? proposal.actions.map((a) => ({ type: a.type, elementId: a.elementId ?? null, key: a.key ?? null, text: typeof a.text === "string" ? a.text.slice(0, 40) : null })) : [],
        });
        console.log(`  call ${call}: ${wallMs}ms prompt=${promptBytes}B in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} kind=${proposal?.kind} actions=[${(proposal?.actions ?? []).map((a) => a.type).join(",")}]`);
        return proposal;
      },
      close: () => bridge.close(),
    };
  }

  // ---- harness --------------------------------------------------------------
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const transport = await connectCdpTransport(launched.wsUrl);
  const host = new AgentViewportHost({
    createWindow: () => { throw new Error("electron constructor used"); },
    createView: () => { throw new Error("electron constructor used"); },
    createPage: () => createCdpView(async () => transport, { width: 1440, height: 900, isolated: true }),
  });

  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-cu-nvidia-"));
  const store = await TaskStore.create({
    originalRequest: GOAL,
    criteria: [{ id: "done", text: GOAL, required: true, verification: "user" }],
    limits: { maxActions: 12, maxPlannerCalls: MAX_CALLS, maxActiveMs: 240000 },
  }, { storageRoot });
  const taskId = store.taskId;
  store.taskProfile = { capability: { id: "computer_use", adapters: [
    { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
    { capabilityId: "computer_use", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
  ] } };

  const adapter = host.ensure(taskId);
  const browser = {
    observe: (...args) => adapter.observe(...args),
    execute: (...args) => adapter.execute(...args),
    supportsAction: adapter.supportsAction ? (...args) => adapter.supportsAction(...args) : undefined,
    setPermissionMode: (mode) => adapter.setPermissionMode?.(mode),
    captureTextObservation: (observation) => host.captureTextObservation(taskId, observation),
    captureComputerUseObservation: (observation) => host.captureComputerUseObservation(taskId, observation),
    dispose: async () => { try { adapter.dispose?.(); } finally { try { await host.dispose?.(taskId); } catch { /* best effort */ } } },
  };

  const controller = new TaskController({
    store, planner, browser,
    approve: async () => ({ decision: "allow", reasons: ["measurement_scope"] }),
    hostVerifier: () => true,
    permissionMode: "interact",
    plannerImageInput: false,
    maxRecoveries: 0,
  });

  const started = performance.now();
  const timer = setTimeout(() => { controller.stop().catch(() => undefined); }, 240000);
  let snapshot = null;
  let error = null;
  try {
    snapshot = await controller.start();
  } catch (e) {
    error = e?.code ?? e?.message ?? String(e);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = Math.round(performance.now() - started);

  // What the page actually shows after the run (the fixture's own truth).
  let pageText = "";
  try { pageText = (await browser.observe()).text ?? ""; } catch { /* page may be gone */ }
  const ticketVisible = /4821/.test(pageText);

  const calls = planner.calls ?? [];
  const inputTokens = calls.reduce((s, c) => s + (c.usage?.inputTokens ?? 0), 0);
  const outputTokens = calls.reduce((s, c) => s + (c.usage?.outputTokens ?? 0), 0);
  const result = {
    provider: has("--dry-run") ? "scripted(dry-run)" : "nvidia",
    model: has("--dry-run") ? null : MODEL,
    keySource,
    goal: GOAL,
    ending: { state: snapshot?.state ?? null, pauseReason: snapshot?.pauseReason ?? null, needUserReason: snapshot?.needUserReason ?? null, budgets: snapshot?.budgets ?? null, error },
    wallMs,
    ticketVisible,
    totals: { calls: calls.length, inputTokens, outputTokens },
    calls,
  };

  console.log(`\nending: ${JSON.stringify(result.ending)}`);
  console.log(`wall: ${wallMs}ms · calls: ${calls.length} · input ${inputTokens} tok · output ${outputTokens} tok · ticket visible: ${ticketVisible}`);
  if (calls.length) {
    console.log("per call:");
    for (const c of calls) console.log(`  #${c.call} ${c.wallMs}ms promptB=${c.promptBytes} ctxB=${c.contextBytes} in=${c.usage?.inputTokens ?? "?"} out=${c.usage?.outputTokens ?? "?"} cu=${c.computerUse ?? "-"} map=${c.screenMapBytes}B els=${c.elementCount} kind=${c.kind} [${c.actionTypes.join(",")}]`);
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(`\nresults: ${OUT}`);

  await controller.stop().catch(() => undefined);
  await browser.dispose().catch(() => undefined);
  await launched.close().catch(() => undefined);
  await store.close().catch(() => undefined);
  await new Promise((r) => server.close(r));
  await fs.rm(storageRoot, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => { console.error(error?.stack || error); process.exit(1); });
