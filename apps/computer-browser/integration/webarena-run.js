"use strict";

// WebArena-Verified runner: drives the HALO harness (real Electron
// BrowserAdapter + TaskController + the local `claude` planner worker) over
// WebArena-Verified tasks and writes, per task, the two files its offline
// evaluator reads: agent_response.json and network.har. Scoring itself is done
// by the benchmark's own `webarena-verified eval-tasks` afterwards.
//
// Arms (HALO_WA_ARM): "baseline" (no escalation) or "escalation" (one step up
// a model tier after a planner failure, the same rule TaskHost uses).
//
// Caveats, stated so a score is not over-read:
//  - HALO's `finish` proposal carries no answer. For RETRIEVE tasks the answer
//    is extracted afterwards by one tool-less `claude -p` call from the task
//    text and the final page text, so retrieval scores include that step.
//  - Task field names (intent, start_urls, task_type) follow the dataset
//    export as documented; verify them against `dataset-get` output.
//  - DATA FLOW: page text and the task go to the Anthropic API through the
//    local `claude` login. Approval is an immediate programmatic allow.
//
// Run from apps/computer-browser (tasks.json from `webarena-verified dataset-get`):
//   HALO_WA_PROVIDER=nvidia NVIDIA_API_KEY=... HALO_WA_TASKS=tasks.json HALO_WA_IDS=108,109 HALO_WA_OUT=out/baseline \
//   HALO_WA_SITES='{"__SHOPPING__":"http://localhost:7770"}' \
//   node_modules/.bin/electron integration/webarena-run.js

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { escalationTarget } = require("../main/harness/planner-escalation");
const { tierOf, modelsInTier } = require("../main/harness/model-tiers");
const { isClaudeModel } = require("../main/harness/providers/claude-models");
const { createHarRecorder } = require("./webarena/har");
const { buildAgentResponse } = require("./webarena/response");

// HALO_WA_PROVIDER=claude (default, local `claude` login) or nvidia (hosted NIM;
// NVIDIA_API_KEY comes from the environment and is passed only to the worker).
const PROVIDER = process.env.HALO_WA_PROVIDER || "claude";
if (!["claude", "nvidia"].includes(PROVIDER)) throw new RangeError("HALO_WA_PROVIDER must be claude or nvidia");
const WORKER = path.resolve(__dirname, "..", "main", "harness", "providers", PROVIDER === "nvidia" ? "nvidia-planner-worker.js" : "claude-code-worker.js");
const { DEFAULT_NVIDIA_MODEL, isNvidiaModel } = require("../main/harness/providers/nvidia-models");
const isModelOf = PROVIDER === "nvidia" ? isNvidiaModel : isClaudeModel;
const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.HALO_WA_MODEL || (PROVIDER === "nvidia" ? DEFAULT_NVIDIA_MODEL : null);

const envInt = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`);
  return value;
};

const fillSites = (text, sites) => Object.entries(sites).reduce((out, [token, url]) => out.split(token).join(url), String(text));

function makePlanner(model) {
  return new PlannerStdioAdapter({
    command: process.execPath,
    args: [WORKER, ...(model ? ["--model", model] : [])],
    cwd: APP_ROOT,
    env: { ELECTRON_RUN_AS_NODE: "1", ...(PROVIDER === "nvidia" && process.env.NVIDIA_API_KEY ? { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY } : {}) },
    timeoutMs: 120000,
  });
}

// One tool-less model call: the task and the last page text in, a JSON array of
// strings out. Returns null if it cannot produce one.
async function extractAnswerNvidia({ intent, pageText }) {
  const prompt = `Task: ${intent}\n\nFinal page text:\n${pageText.slice(0, 12000)}\n\nIf the task asks for information, reply with ONLY a JSON array of strings holding the answer values found on the page. If the page does not contain the answer, reply with []. No other text.`;
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 1024 }),
    });
    if (!response.ok) return null;
    const text = (await response.json())?.choices?.[0]?.message?.content ?? "";
    const match = String(text).match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : "");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch { return null; }
}

function extractAnswer({ intent, pageText }) {
  if (PROVIDER === "nvidia") return extractAnswerNvidia({ intent, pageText });
  return new Promise((resolve) => {
    const prompt = `Task: ${intent}\n\nFinal page text:\n${pageText.slice(0, 12000)}\n\nIf the task asks for information, reply with ONLY a JSON array of strings holding the answer values found on the page. If the page does not contain the answer, reply with []. No other text.`;
    const child = spawn("claude", ["-p", "--output-format", "text"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const match = out.match(/\[[\s\S]*\]/);
      try { const parsed = JSON.parse(match ? match[0] : ""); resolve(Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null); }
      catch { resolve(null); }
    });
    child.stdin.end(prompt);
  });
}

async function runTask({ task, sites, arm, outDir, timeoutMs, createBrowser, har }) {
  const intent = fillSites(task.intent, sites);
  const startUrl = fillSites((task.start_urls || [])[0] || "", sites);
  const taskType = task.task_type || task.type || "NAVIGATE";
  const startedAt = performance.now();
  const counts = { plannerCalls: 0, escalations: 0 };
  let lastPageText = "";

  const browser = await createBrowser();
  const observe = browser.observe.bind(browser);
  browser.observe = async (...args) => {
    const observation = await observe(...args);
    lastPageText = [observation?.text || "", ...(observation?.elements || []).map((item) => item.name || "")].join("\n");
    return observation;
  };

  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-wa-"));
  const store = await TaskStore.create({
    originalRequest: `${intent}${startUrl ? ` Start at ${startUrl}.` : ""} Finish when the task is done; do not ask the user questions.`,
    criteria: [{ id: "done", text: "the task is completed", required: true, verification: "user" }],
    limits: { maxActions: 300, maxPlannerCalls: 150, maxActiveMs: timeoutMs },
  }, { storageRoot });

  const tried = new Set();
  let currentModel = DEFAULT_MODEL;
  // One wrapper per planner: the controller closes the PREVIOUS wrapper on
  // escalation, which must close only the old planner, not the new one.
  const wrap = (inner) => ({
    warm: () => inner.warm?.(),
    close: () => inner.close(),
    next: async (context, options) => { counts.plannerCalls += 1; return inner.next(context, options); },
  });
  let counted = wrap(makePlanner(currentModel));
    const escalatePlanner = arm === "escalation" ? async () => {
    if (!currentModel) return null;
    tried.add(currentModel);
    const candidates = [...modelsInTier(1), ...modelsInTier(2)].filter(isModelOf);
    const target = escalationTarget({ currentModel, candidates, tried, tierOf });
    if (!target) return null;
    tried.add(target);
    const from = currentModel;
    currentModel = target;
    counts.escalations += 1;
    counted = wrap(makePlanner(target));
    return { planner: counted, from, to: target };
  } : null;

  const controller = new TaskController({
    store, planner: counted, browser,
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
    harnessProfile: "long",
    ...(escalatePlanner ? { escalatePlanner } : {}),
  });

  let state = "unknown";
  let pauseReason = null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.stop().catch(() => {}); }, timeoutMs);
  try {
    const snapshot = await controller.start();
    state = snapshot.state; pauseReason = snapshot.pauseReason ?? null;
  } catch (error) {
    state = `error: ${String(error.message).slice(0, 120)}`;
  } finally {
    clearTimeout(timer);
  }

  let answer = null;
  if (taskType === "RETRIEVE" && (state === "completed" || state === "awaiting_verification")) answer = await extractAnswer({ intent, pageText: lastPageText });
  const response = buildAgentResponse({ taskType, state, pauseReason, answer, timedOut });

  const dir = path.join(outDir, String(task.task_id));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "agent_response.json"), JSON.stringify(response, null, 2));
  await fs.writeFile(path.join(dir, "network.har"), JSON.stringify(har.toHar()));
  await counted.close().catch(() => {});
  await browser.dispose().catch(() => {});
  await store.close().catch(() => {});
  await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  return { task_id: task.task_id, arm, taskType, state, pauseReason, timedOut, status: response.status, totalMs: Math.round(performance.now() - startedAt), ...counts };
}

async function main() {
  const { app, BrowserWindow, WebContentsView, session } = require("electron");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");

  const arm = process.env.HALO_WA_ARM || "baseline";
  if (!["baseline", "escalation"].includes(arm)) throw new RangeError("HALO_WA_ARM must be baseline or escalation");
  const tasksFile = process.env.HALO_WA_TASKS;
  const outDir = path.resolve(process.env.HALO_WA_OUT || "out/webarena");
  if (PROVIDER === "nvidia" && !process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is required for HALO_WA_PROVIDER=nvidia");
  if (!tasksFile) throw new Error("HALO_WA_TASKS is required");
  const sites = JSON.parse(process.env.HALO_WA_SITES || "{}");
  const ids = process.env.HALO_WA_IDS ? new Set(process.env.HALO_WA_IDS.split(",").map((id) => id.trim())) : null;
  const timeoutMs = envInt("HALO_WA_TIMEOUT_S", 600, 30, 3600) * 1000;
  const all = JSON.parse(await fs.readFile(tasksFile, "utf8"));
  const tasks = (Array.isArray(all) ? all : all.tasks || []).filter((task) => !ids || ids.has(String(task.task_id)));

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  await fs.mkdir(outDir, { recursive: true });
  const results = [];
  let exitCode = 0;
  try {
    for (const task of tasks) {
      const partition = `halo-wa-${task.task_id}-${Date.now()}`;
      const har = createHarRecorder();
      har.attach(session.fromPartition(partition));
      const result = await runTask({
        task, sites, arm, outDir, timeoutMs, har,
        createBrowser: async () => {
          const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
          win.contentView.addChildView(view);
          view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
          view.setVisible(false);
          return new BrowserAdapter({ view });
        },
      });
      results.push(result);
      await fs.appendFile(path.join(outDir, "summary.jsonl"), `${JSON.stringify(result)}\n`);
      console.error(`[webarena-run] ${task.task_id}: ${result.status} (${result.state}) ${result.totalMs}ms`);
    }
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "webarena-run", arm, outDir, tasks: results.length, results })}\n`);
  } catch (error) {
    exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "webarena-run", error: String(error?.stack || error), results })}\n`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

if (process.versions.electron || require.main === module) main();
