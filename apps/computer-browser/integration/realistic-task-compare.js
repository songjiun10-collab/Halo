"use strict";

// Realistic multi-site task, same model, two arms:
//   raw     - the model gets the page (url/title/links) each step and answers with one JSON action;
//             actions run directly on a WebContentsView. No TaskStore, TaskController, BrowserAdapter,
//             policy, approval, journal, or checkpoint.
//   harness - the real HALO TaskController + BrowserAdapter + durable TaskStore with the real
//             claude-code-worker planner and an immediate programmatic "allow" approval.
// Public read-only sites (MDN, nodejs.org); no login, no input, no downloads. Every planner/model call
// sends the goal and page text to the Anthropic API through the local `claude` login (real cost).
// Not a benchmark: one run per arm, nondeterministic. Success is checked by the host, not by the model.
//
// Run from apps/computer-browser:
//   node_modules/.bin/electron integration/realistic-task-compare.js
// Env: HALO_RT_PROVIDER (claude|codex), HALO_RT_ARMS (default "raw,harness"), HALO_RT_MODEL (default claude-sonnet-5-5),
//   HALO_RT_TIMEOUT_S (60..1800, default 420), HALO_RT_MAX_STEPS (default 30). Emits RESULT_JSON:<json>.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");

const PROVIDER = process.env.HALO_RT_PROVIDER === "codex" ? "codex" : "claude";
const WORKER = path.resolve(__dirname, "..", "main", "harness", "providers", PROVIDER === "codex" ? "codex-planner-worker.js" : "claude-code-worker.js");
const APP_ROOT = path.resolve(__dirname, "..");
const MODEL = process.env.HALO_RT_MODEL || (PROVIDER === "codex" ? "gpt-6-luna" : "claude-sonnet-5-5");
const TIMEOUT_MS = Number(process.env.HALO_RT_TIMEOUT_S || 420) * 1000;
const PROFILE = process.env.HALO_RT_PROFILE || ""; // short|fast|middle|long; empty = controller default
const MAX_STEPS = Number(process.env.HALO_RT_MAX_STEPS || 30);

const START_URL = "https://developer.mozilla.org/";
const GOAL = process.env.HALO_RT_GOAL || "MDN에서 structuredClone() 문서를 찾아 Node.js 지원 시작 버전을 확인한 다음, "
  + "Node.js 공식 문서(nodejs.org)에서 structuredClone이 설명된 페이지로 이동해줘. "
  + `시작 페이지는 ${START_URL} 이야. 읽기만 하고 아무것도 입력하거나 제출하지 마.`;

// Host-side success: the run visited the MDN structuredClone page and ended on nodejs.org's globals docs.
function succeeded(visited, currentUrl) {
  const mdn = visited.some((u) => /developer\.mozilla\.org\/.*structuredClone/i.test(u));
  let onNode = false;
  try {
    const url = new URL(currentUrl);
    onNode = url.hostname.endsWith("nodejs.org") && /^\/(?:[a-z]{2}\/)?(?:docs\/[^/]+\/)?api\/globals/i.test(url.pathname);
  } catch { /* not a URL */ }
  return mdn && onNode;
}

function newUsage() { return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }; }
function addUsage(total, u) {
  if (!u) return;
  total.calls += 1;
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd"]) total[k] += u[k] || 0;
}

// ---- raw arm ---------------------------------------------------------------------------------

const LINKS_SCRIPT = `(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const r = a.getBoundingClientRect();
    const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!text || a.href.startsWith('javascript:')) continue;
    out.push({ text, href: a.href });
    if (out.length >= 80) break;
  }
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1800), links: out };
})()`;

function askCodex(prompt) {
  const { resolveCodexCommand } = require("../main/harness/providers/codex-planner-worker");
  const { CODEX_ENV_ALLOWLIST } = require("../main/harness/providers/codex-planner-bridge");
  const { normalizeUsage } = require("../shared/usage");
  const workDir = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "halo-rt-codex-"));
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of CODEX_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(resolveCodexCommand(), ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
      "-s", "read-only", "-C", workDir, "-m", MODEL, "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const killer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      require("node:fs").rmSync(workDir, { recursive: true, force: true });
      const events = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const msgs = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message");
      const done = events.find((e) => e.type === "turn.completed");
      if (!msgs.length) return reject(new Error(`codex exited ${code}: ${(err || out).slice(0, 300)}`));
      resolve({ text: String(msgs.at(-1).item.text), usage: normalizeUsage("codex", done) || {} });
    });
    child.stdin.end(prompt);
  });
}

function askClaude(prompt) {
  if (PROVIDER === "codex") return askCodex(prompt);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", MODEL, "--output-format", "json", "--tools", "", "--no-session-persistence", "--disable-slash-commands"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const env = JSON.parse(out);
        const u = env.usage || {};
        resolve({
          text: String(env.result ?? ""),
          usage: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cacheReadTokens: u.cache_read_input_tokens || 0, cacheCreationTokens: u.cache_creation_input_tokens || 0, costUsd: env.total_cost_usd || 0 },
        });
      } catch { reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`)); }
    });
    child.stdin.end(prompt);
  });
}

async function runRaw({ createView }) {
  const view = createView();
  const wc = view.webContents;
  const usage = newUsage();
  const visited = [];
  const history = [];
  const t0 = performance.now();
  let steps = 0;
  let state = "step_limit";
  const load = async (url) => {
    await Promise.race([wc.loadURL(url).catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    await new Promise((r) => setTimeout(r, 800));
  };
  try {
    await load(START_URL);
    while (steps < MAX_STEPS && performance.now() - t0 < TIMEOUT_MS) {
      const page = await wc.executeJavaScript(LINKS_SCRIPT);
      if (visited.at(-1) !== page.url) visited.push(page.url);
      if (succeeded(visited, page.url)) { state = "success"; break; }
      const prompt = [
        "You control a web browser. Goal:", GOAL, "",
        "Reply with ONLY one JSON object, no prose: {\"action\":\"goto\",\"url\":\"https://...\"} or {\"action\":\"click\",\"index\":N} (N indexes the links list) or {\"action\":\"done\"}.",
        "Use done only when you believe the goal is complete.", "",
        `History (oldest first): ${JSON.stringify(history.slice(-12))}`, "",
        `Current page: ${page.url}`, `Title: ${page.title}`, `Text: ${page.text}`,
        `Links: ${JSON.stringify(page.links.map((l, i) => [i, l.text, l.href]))}`,
      ].join("\n");
      const { text, usage: u } = await askClaude(prompt);
      addUsage(usage, u);
      steps += 1;
      let action;
      try { action = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ""); } catch { history.push("unparseable reply"); continue; }
      if (action.action === "done") { state = "model_done"; break; }
      let target = null;
      if (action.action === "goto" && /^https?:\/\//.test(action.url)) target = action.url;
      if (action.action === "click" && Number.isInteger(action.index) && page.links[action.index]) target = page.links[action.index].href;
      history.push(target ? `${action.action} ${target}` : "invalid action");
      if (target) await load(target);
    }
    const last = await wc.executeJavaScript("location.href").catch(() => "");
    if (visited.at(-1) !== last && last) visited.push(last);
    if (state !== "success" && succeeded(visited, last)) state = "success";
    return { arm: "raw", success: state === "success", state, steps, modelCalls: usage.calls, wallMs: Math.round(performance.now() - t0), usage, pages: visited.length, path: visited };
  } finally {
    wc.close?.();
  }
}

// ---- harness arm -----------------------------------------------------------------------------

async function runHarness({ createBrowser, storageRoot }) {
  const usage = newUsage();
  const visited = [];
  let currentUrl = "";
  let found = false;
  let controller = null;
  const t0 = performance.now();
  let plannerCalls = 0;
  let approvals = 0;
  let userApprovals = 0;

  const browser = await createBrowser();
  const execute0 = browser.execute.bind(browser);
  browser.execute = async (...a) => { console.error(`EXEC start ${a[0]?.type}`); try { const r = await execute0(...a); console.error(`EXEC end ${JSON.stringify(r).slice(0, 120)}`); return r; } catch (e) { console.error(`EXEC throw ${e?.message}`); throw e; } };
  const trace = [];
  const origPush = trace.push.bind(trace);
  trace.push = (...items) => { for (const i of items) console.error(`TRACE ${Math.round(performance.now() - t0)}ms ${JSON.stringify(i).slice(0, 300)}`); return origPush(...items); };
  const observe = browser.observe.bind(browser);
  browser.observe = async (...args) => {
    console.error('OBS start');
    const obs = await observe(...args).catch((error) => { trace.push({ observeError: String(error?.message || error).slice(0, 300), code: error?.code }); throw error; });
    if (obs?.url && obs.url !== "about:blank") {
      currentUrl = obs.url;
      if (visited.at(-1) !== obs.url) visited.push(obs.url);
      if (!found && succeeded(visited, obs.url)) { found = true; Promise.resolve().then(() => controller?.stop()).catch(() => {}); }
    }
    return obs;
  };
  const store = await TaskStore.create({
    originalRequest: GOAL,
    criteria: [{ id: "done", text: "ended on the Node.js docs page for structuredClone after reading MDN", required: true, verification: "user" }],
    limits: { maxActions: 200, maxPlannerCalls: 120, maxActiveMs: TIMEOUT_MS },
  }, { storageRoot });
  const planner = new PlannerStdioAdapter({
    command: process.execPath, args: [WORKER, "--model", MODEL, ...(PROFILE === "fast" && PROVIDER === "codex" ? ["--fast"] : [])], cwd: APP_ROOT, env: { ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: 180000,
    onUsage: (u) => addUsage(usage, u),
  });
  controller = new TaskController({
    store,
    planner: { warm: () => planner.warm?.(), close: () => planner.close(), next: async (c, o) => { plannerCalls += 1; const p = await planner.next(c, o).catch((e) => { process.stderr.write(`PLANNER_ERR ${e?.code || ''} ${String(e?.message || e).slice(0, 400)}\n`); throw e; }); trace.push({ at: c.observation?.url, http: c.observation?.httpStatus, kind: p.kind, reason: p.reason?.slice?.(0, 200), actions: (p.actions || []).map((a) => `${a.type}${a.elementId ? ":" + a.elementId : ""}${a.url ? " " + a.url : ""}`) }); return p; } },
    browser,
    approve: async () => { approvals += 1; return { decision: "allow", reasons: [] }; },
    hostVerifier: () => true,
    ...(PROFILE ? { harnessProfile: PROFILE, plannerEffort: process.env.HALO_RT_EFFORT || (PROFILE === "short" ? "low" : "medium"), adaptiveEffort: process.env.HALO_RT_ADAPTIVE === "1" } : {}),
  });
  let endState;
  const timer = setTimeout(() => controller.stop().catch(() => {}), TIMEOUT_MS);
  try {
    // The task starts on the start page, like the raw arm.
    await browser.execute({ type: "navigate", url: START_URL }).catch(() => {});
    // A simulated user clicks Allow on every queued approval at once (zero human latency).
    let snap = await controller.start();
    while (!found && snap.state === "awaiting_approval" && snap.approvalQueue?.length && userApprovals < 60) {
      userApprovals += 1;
      snap = await controller.approve(snap.approvalQueue[0].id);
    }
    endState = `${snap.state}/${snap.pauseReason ?? "-"}`;
  } catch (error) {
    endState = `error: ${error.message}`;
  } finally {
    clearTimeout(timer);
    const snap = controller.getSnapshot();
    const actions = snap.budgets?.actionsUsed ?? null;
    await planner.close().catch(() => {});
    await browser.dispose().catch(() => {});
    await store.close().catch(() => {});
    return { arm: "harness", success: found, state: endState, steps: actions, modelCalls: plannerCalls, approvals, userApprovals, wallMs: Math.round(performance.now() - t0), usage, pages: visited.length, path: visited, trace, pauseReason: snap.pauseReason, needUser: snap.needUser ?? snap.pendingQuestion ?? null };
  }
}

async function main() {
  const { app, BrowserWindow, WebContentsView } = require("electron");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");
  const arms = (process.env.HALO_RT_ARMS || "raw,harness").split(",").map((s) => s.trim());
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-rt-"));
  const makeView = (partition) => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    view.setVisible(false);
    return view;
  };
  let code = 0;
  const runs = [];
  try {
    for (const arm of arms) {
      console.error(`[realistic-task-compare] arm ${arm} starting`);
      const watchdog = new Promise((resolve) => setTimeout(() => resolve({ arm, success: false, state: "watchdog_hung", note: "arm exceeded timeout+90s and was abandoned" }), TIMEOUT_MS + 90000));
      if (arm === "raw") runs.push(await Promise.race([runRaw({ createView: () => makeView("halo-rt-raw") }), watchdog]));
      else if (arm === "harness") runs.push(await Promise.race([runHarness({ storageRoot, createBrowser: async () => new BrowserAdapter({ view: makeView("halo-rt-harness") }) }), watchdog]));
      console.error(`[realistic-task-compare] arm ${arm} done: ${runs.at(-1).success ? "success" : runs.at(-1).state}`);
      console.error(`ARM_JSON:${JSON.stringify(runs.at(-1))}`);
    }
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "realistic-task-compare", model: MODEL, goal: GOAL, runs })}\n`);
  } catch (error) {
    code = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "realistic-task-compare", error: String(error?.stack || error), runs })}\n`);
  } finally {
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }
}

main();
