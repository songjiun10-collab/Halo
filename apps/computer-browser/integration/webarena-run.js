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
if (!["claude", "nvidia", "codex"].includes(PROVIDER)) throw new RangeError("HALO_WA_PROVIDER must be claude, nvidia or codex");
const WORKER = path.resolve(__dirname, "..", "main", "harness", "providers", ({ nvidia: "nvidia-planner-worker.js", codex: "codex-planner-worker.js" })[PROVIDER] || "claude-code-worker.js");
const { DEFAULT_NVIDIA_MODEL, isNvidiaModel } = require("../main/harness/providers/nvidia-models");
const { isCodexModel } = require("../main/harness/providers/codex-models");
const isModelOf = PROVIDER === "nvidia" ? isNvidiaModel : PROVIDER === "codex" ? isCodexModel : isClaudeModel;
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


// Parses the extraction reply: a JSON object (task names keys) or a JSON array.
function parseExtracted(text) {
  const source = String(text);
  const start = source.search(/[\[{]/);
  if (start < 0) return null;
  const open = source[start];
  const end = source.lastIndexOf(open === "[" ? "]" : "}");
  if (end <= start) return null;
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    if (Array.isArray(value)) return value.every((item) => typeof item === "string" || typeof item === "number") ? value : null;
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

// One tool-less model call: the task and the last page text in, a JSON array of
// strings out. Returns null if it cannot produce one.
async function extractAnswerNvidia({ intent, pageText }) {
  const prompt = `Task: ${intent}\n\nFinal page text:\n${pageText.slice(0, 12000)}\n\nIf the task asks for information, reply with ONLY the JSON the task asks for: a JSON object when the task names keys (use numbers for numeric values), otherwise a JSON array of the answer values (strings or numbers). If the page does not contain the answer, reply with []. No other text.`;
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      body: JSON.stringify({ model: DEFAULT_NVIDIA_MODEL, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 1024 }),
    });
    if (!response.ok) return null;
    const text = (await response.json())?.choices?.[0]?.message?.content ?? "";
    return parseExtracted(text);
  } catch { return null; }
}

function extractAnswer({ intent, pageText }) {
  if (PROVIDER !== "claude") return extractAnswerNvidia({ intent, pageText });
  return new Promise((resolve) => {
    const prompt = `Task: ${intent}\n\nFinal page text:\n${pageText.slice(0, 12000)}\n\nIf the task asks for information, reply with ONLY the JSON the task asks for: a JSON object when the task names keys (use numbers for numeric values), otherwise a JSON array of the answer values (strings or numbers). If the page does not contain the answer, reply with []. No other text.`;
    const child = spawn("claude", ["-p", "--output-format", "text"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 90000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseExtracted(out));
    });
    child.stdin.end(prompt);
  });
}

// Loads a Playwright storage_state (from the benchmark's own login helper) into
// the task's Electron session, so a logged-in task starts logged in.
async function injectStorageState(electronSession, task, sites) {
  const stateFile = process.env.HALO_WA_STATE_DIR && task.storage_state ? path.join(process.env.HALO_WA_STATE_DIR, path.basename(task.storage_state)) : null;
  if (!stateFile) return;
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  for (const cookie of state.cookies || []) {
    const host = String(cookie.domain || "").replace(/^\./, "");
    const origin = Object.values(sites).find((url) => new URL(url).hostname === host) || `http://${host}`;
    await electronSession.cookies.set({
      url: origin, name: cookie.name, value: cookie.value, path: cookie.path || "/",
      secure: false, httpOnly: !!cookie.httpOnly,
      ...(cookie.expires && cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    }).catch(() => {});
  }
}

async function runTask({ task, sites, arm, outDir, timeoutMs, createBrowser, har }) {
  const intent = fillSites(task.intent, sites);
  const startUrl = fillSites((task.start_urls || [])[0] || task.start_url || "", sites);
  // The dataset keeps the operation under eval[].expected.task_type.
  // The original WebArena config has eval.eval_types: an answer is only asked
  // for when the task has reference answers; otherwise it is judged by URL/DOM.
  const originalType = task.eval && !Array.isArray(task.eval) && Array.isArray(task.eval.eval_types)
    ? (task.eval.reference_answers && Object.keys(task.eval.reference_answers).length ? "RETRIEVE" : "NAVIGATE") : null;
  const taskType = originalType || task.task_type || (Array.isArray(task.eval) ? task.eval : []).map((entry) => entry?.expected?.task_type).find(Boolean) || "NAVIGATE";
  const startedAt = performance.now();
  const counts = { plannerCalls: 0, escalations: 0, userPrompts: 0, replyAnswers: 0 };
  let lastPageText = "";
  let lastUrl = startUrl;

  const browser = await createBrowser();
  const observe = browser.observe.bind(browser);
  browser.observe = async (...args) => {
    const observation = await observe(...args);
    if (typeof observation?.url === "string" && observation.url) lastUrl = observation.url;
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
    next: async (context, options) => {
      counts.plannerCalls += 1;
      const proposal = await inner.next(context, options);
      if (process.env.HALO_WA_TRACE) (counts.proposals ||= []).push(JSON.stringify(proposal?.proposal ?? proposal).slice(0, 260));
      return proposal;
    },
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
    permissionMode: "full",
    ...(escalatePlanner ? { escalatePlanner } : {}),
  });

  let replyAnswer = null;
  let state = "unknown";
  let pauseReason = null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.stop().catch(() => {}); }, timeoutMs);
  try {
    let snapshot = await controller.start();
    // No human in a benchmark: answer a need_user pause once per round with a
    // fixed "decide yourself" amendment (max 3, counted in the result).
    // For RETRIEVE, Halo delivers an answer to an information request as the
    // need_user reason (the planner's `finish` has no answer field). Treat a
    // need_user that yields an answer as the agent's reply, not as being stuck.
    const takeReply = async () => {
      if (taskType !== "RETRIEVE" || snapshot.state !== "paused" || snapshot.pauseReason !== "need_user") return false;
      const reason = String(snapshot.needUserReason || "");
      if (!reason.trim()) return false;
      const found = await extractAnswer({ intent, pageText: `Agent reply: ${reason}\n\n${lastPageText}` });
      if (!found || found.length === 0) return false;
      replyAnswer = found; counts.replyAnswers += 1;
      return true;
    };
    while (!(await takeReply()) && snapshot.state === "paused" && snapshot.pauseReason === "need_user" && counts.userPrompts < 3 && !timedOut) {
      counts.userPrompts += 1;
      (counts.questions ||= []).push(String(snapshot.needUserReason || "").slice(0, 300));
      await controller.amend({ text: "No user is available to answer questions. Decide on your own using the best interpretation and continue; finish when the goal is reached.", supersedesConstraintIds: [], newConstraints: [], newCriteria: [] });
      snapshot = await controller.resume();
    }
    state = snapshot.state; pauseReason = snapshot.pauseReason ?? null;
    if (replyAnswer) { state = "completed"; pauseReason = null; }
  } catch (error) {
    state = `error: ${String(error.message).slice(0, 120)}`;
  } finally {
    clearTimeout(timer);
  }

  const trace = (await store.getEvents().catch(() => [])).filter((ev) => ev.type === "note" || ev.type === "action_outcome").slice(-14).map((ev) => ev.type === "note" ? `note:${String(ev.payload?.msg || "").slice(0, 80)}` : `out:${JSON.stringify(ev.payload).slice(0, 230)}`);
  const pendingApprovals = (controller.getSnapshot().approvalQueue || []).map((item) => `${item.action}: ${String(item.summary).slice(0, 160)}`);
  let answer = replyAnswer;
  if (!answer && taskType === "RETRIEVE" && (state === "completed" || state === "awaiting_verification")) answer = await extractAnswer({ intent, pageText: lastPageText });
  const response = buildAgentResponse({ taskType, state, pauseReason, answer, timedOut });

  const dir = path.join(outDir, String(task.task_id));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "agent_response.json"), JSON.stringify(response, null, 2));
  await fs.writeFile(path.join(dir, "network.har"), JSON.stringify(har.toHar()));
  // Input for the original WebArena evaluators: the final answer string and URL.
  const answerText = Array.isArray(answer) ? answer.join(", ") : answer && typeof answer === "object" ? JSON.stringify(answer) : "";
  await fs.writeFile(path.join(dir, "original.json"), JSON.stringify({ task_id: task.task_id, answer: answerText, final_url: lastUrl, state, pauseReason, timedOut }));
  await counted.close().catch(() => {});
  await browser.dispose().catch(() => {});
  await store.close().catch(() => {});
  await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  return { task_id: task.task_id, arm, taskType, state, pauseReason, timedOut, ...(pendingApprovals.length ? { pendingApprovals } : {}), ...(process.env.HALO_WA_TRACE ? { trace } : {}), status: response.status, totalMs: Math.round(performance.now() - startedAt), ...counts };
}

async function main() {
  const { app, BrowserWindow, WebContentsView, session } = require("electron");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");

  const arm = process.env.HALO_WA_ARM || "baseline";
  if (!["baseline", "escalation"].includes(arm)) throw new RangeError("HALO_WA_ARM must be baseline or escalation");
  const tasksFile = process.env.HALO_WA_TASKS;
  const outDir = path.resolve(process.env.HALO_WA_OUT || "out/webarena");
  if (PROVIDER !== "claude" && !process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is required for answer extraction (nvidia and codex providers)");
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
    // Resume after a crash: tasks already in summary.jsonl are not run again.
    const doneIds = new Set();
    try {
      for (const line of (await fs.readFile(path.join(outDir, "summary.jsonl"), "utf8")).split("\n")) {
        if (line.trim()) { const prior = JSON.parse(line); doneIds.add(String(prior.taskId ?? prior.task_id)); results.push(prior); }
      }
    } catch { /* first run */ }
    const infraFailure = (result) => /^error/.test(String(result.state)) || ["planner_error", "planner_unavailable", "browser_unavailable"].includes(result.pauseReason);
    for (const task of tasks) {
      if (doneIds.has(String(task.task_id))) { console.error(`[webarena-run] ${task.task_id}: skipped (already done)`); continue; }
      let result;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        // Wait for the site to answer before spending a planner run on it.
        const origin = new URL(String(task.start_url || "").replace(/__([A-Z_]+)__/g, (m, k) => sites[m] || m) || "http://localhost").origin;
        for (let wait = 0; wait < 20; wait += 1) {
          const ok = await fetch(origin, { signal: AbortSignal.timeout(20000) }).then((r) => r.status < 500).catch(() => false);
          if (ok) break;
          console.error(`[webarena-run] ${task.task_id}: site ${origin} not answering, waiting (${wait + 1}/20)`);
          await new Promise((resolve) => setTimeout(resolve, 15000));
        }
        const partition = `halo-wa-${task.task_id}-${Date.now()}`;
        const har = createHarRecorder();
        har.attach(session.fromPartition(partition));
        try {
          await injectStorageState(session.fromPartition(partition), task, sites);
          result = await runTask({
            task, sites, arm, outDir, timeoutMs, har,
            createBrowser: async () => {
              const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
              win.contentView.addChildView(view);
              view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
              view.setVisible(false);
              return new BrowserAdapter({ view });
            },
          });
        } catch (error) {
          result = { task_id: task.task_id, arm, status: "UNKNOWN_ERROR", state: `error: ${String(error?.message || error).slice(0, 120)}`, totalMs: 0 };
        }
        if (!infraFailure(result) || attempt === 3) break;
        console.error(`[webarena-run] ${task.task_id}: infra failure (${result.state}/${result.pauseReason}), retry ${attempt}/2`);
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
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
