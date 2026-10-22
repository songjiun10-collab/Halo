"use strict";
// "Vanilla" arm for the Online-Mind2Web comparison: the same model, the same Chromium (CDP) view, the same
// tasks, limits, profile and captcha heuristic as integration/online-mind2web-bench.ts, but WITHOUT the HALO
// harness: no TaskStore/TaskController, no Task Contract, no permission or safety gates, no approver, no
// budget manager, no captcha reroute. One loop: screenshot + URL + visible text -> model -> one action -> run it.
// It is deliberately a plain, standard browser agent, not a weakened one. Compare it against HALO run with
// HALO_BENCH_OPEN_UNSAFE=1 (the other arm is also ungated); HALO's default "review" profile asks a human before
// every click and cannot run unattended.
//
// Run: ANTHROPIC_API_KEY=... [HALO_BENCH_PROFILE=/abs/demo-profile] HALO_BENCH_MODEL=claude-haiku-5-5 \
//      HALO_BENCH_UNOFFICIAL_TASKS=1 node integration/vanilla-mind2web-bench.ts /abs/tasks.json
//   HALO_BENCH_LIMIT=N / HALO_BENCH_RESUME=<dir> behave as in the HALO runner. Output files have the same shape
//   (result.json, run.json, steps.jsonl, trajectory/*.png), so tools/grade-bench.js and tools/compare-aside-bench.js
//   read both arms unchanged. Ungraded locally; never uploads data. CAPTCHA pages are not solved or rerouted.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const nodeCrypto = require("node:crypto");
const { performance: benchClock } = require("node:perf_hooks");
const { looksLikeCaptcha } = require("../shared/captcha-heuristics");
const { selectTasks, classify } = require("./online-mind2web-bench.ts");

type Task = { task_id: string; confirmed_task: string; website: string; reference_length: number; level: string };
// Same ceilings as the HALO arm: 100 model calls (HALO: maxPlannerCalls) and 15 minutes of active time.
const LIMITS = { maxSteps: 100, maxActiveMs: 900000 };
const VIEWPORT = { width: 1440, height: 900 };
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Space"]);

const SYSTEM = [
  "You control a web browser to complete the user's task. Each turn you get a screenshot of the current page, its URL,",
  "its visible text, and the actions you already took. Call the `act` tool with exactly one action.",
  "Click by pixel position on the screenshot. To type, click the field first, then use type. Use finish with your answer",
  "(or a short statement of what you did) when the task is done or cannot be done. Do not ask questions.",
].join(" ");

const ACT_TOOL = {
  name: "act", description: "Perform one browser action.",
  input_schema: { type: "object", additionalProperties: false, required: ["type"], properties: {
    type: { type: "string", enum: ["click", "type", "key", "scroll", "navigate", "back", "finish"] },
    x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, key: { type: "string" },
    dy: { type: "number", description: "scroll amount in pixels, positive is down" },
    url: { type: "string" }, answer: { type: "string" } } },
};

// Returns a normalized action, or null when the model's tool input is not a usable action.
function parseAction(input: any): any | null {
  if (!input || typeof input !== "object") return null;
  const n = (v: any) => Number.isFinite(v);
  switch (input.type) {
    case "click": return n(input.x) && n(input.y) ? { type: "click", x: input.x, y: input.y } : null;
    case "type": return typeof input.text === "string" && input.text.length <= 2000 ? { type: "type", text: input.text } : null;
    case "key": return KEYS.has(input.key) ? { type: "key", key: input.key } : null;
    case "scroll": return n(input.dy) ? { type: "scroll", dy: Math.max(-3000, Math.min(3000, input.dy)) } : null;
    case "navigate": {
      try { const u = new URL(input.url); return u.protocol === "https:" || u.protocol === "http:" ? { type: "navigate", url: u.href } : null; } catch { return null; }
    }
    case "back": return { type: "back" };
    case "finish": return typeof input.answer === "string" ? { type: "finish", answer: input.answer.slice(0, 4000) } : null;
    default: return null;
  }
}

async function perform(view: any, action: any, scale: number): Promise<void> {
  const wc = view.webContents;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  switch (action.type) {
    case "click": {
      const x = Math.round(action.x * scale), y = Math.round(action.y * scale);
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      break;
    }
    case "type": wc.insertText(action.text); break;
    case "key": wc.sendInputEvent({ type: "keyDown", keyCode: action.key }); wc.sendInputEvent({ type: "keyUp", keyCode: action.key }); break;
    case "scroll": wc.sendInputEvent({ type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX: 0, deltaY: -action.dy }); break;
    case "navigate": await wc.loadURL(action.url); break;
    case "back": await wc.executeJavaScript("history.back()"); break;
  }
  await sleep(800); // let the page react before the next screenshot
}

async function callAnthropic(body: any, apiKey: string, fetchFn = globalThis.fetch): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(120000),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    throw Object.assign(new Error(`model_http_${res.status}`), { code: `model_http_${res.status}` });
  }
}

// Same model through the local Claude Code login instead of an API key (HALO_BENCH_VIA=claude-code), so both
// arms reach Haiku the same way. Same flags as the HALO planner bridge (no tools, safe mode, no session), the
// screenshot goes in as an image block, and the act schema is enforced with --json-schema. Returns the shape of
// a Messages API reply so runLoop does not care which route it took.
// The CLI has no `act` tool to call; the structured reply takes its place. Without this note Haiku said it "could not use act".
const VIA_CLI_NOTE = "Your structured JSON reply IS the `act` tool call: put the one action's fields in it.";
function callClaudeCode(body: any, { spawnFn = require("node:child_process").spawn, effort = "medium", timeoutMs = 120000 } = {}): Promise<any> {
  const { ENV_ALLOWLIST, HOST_ENV } = require("../main/harness/providers/claude-code-bridge");
  const env: Record<string, string> = { ...HOST_ENV };
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  const args = ["-p", "--model", body.model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--tools", "", "--safe-mode", "--permission-prompts", "none", "--no-session-persistence", "--disable-slash-commands",
    "--json-schema", JSON.stringify(ACT_TOOL.input_schema), "--append-system-prompt", `${body.system} ${VIA_CLI_NOTE}`, "--effort", effort];
  return new Promise((resolve, reject) => {
    const child = spawnFn("claude", args, { env, shell: false, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(Object.assign(new Error("model_spawn_failed"), { code: "model_spawn_failed" })); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const result = out.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((m) => m?.type === "result");
      if (code !== 0 || !result || result.is_error) return reject(Object.assign(new Error("model_cli_error"), { code: code === null ? "model_timeout" : "model_cli_error" }));
      const u = result.usage ?? {};
      resolve({ content: result.structured_output ? [{ type: "tool_use", name: "act", input: result.structured_output }] : [],
        usage: { input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0 } });
    });
    child.stdin.end(JSON.stringify({ type: "user", message: body.messages[0] }) + "\n");
  });
}

// The loop, with the model call injected so it can be tested without a network or a browser.
async function runLoop({ view, task, model, callModel, record, now = () => benchClock.now(), limits = LIMITS }: any) {
  const history: string[] = [], usages: any[] = [], steps: any[] = [];
  let finalAnswer = "", finished = false, errorCode: string | null = null, calls = 0;
  const started = now();
  while (!finished && calls < limits.maxSteps && now() - started < limits.maxActiveMs) {
    const wc = view.webContents;
    const image = await wc.capturePage();
    const size = image.getSize();
    const scale = size.width > 0 ? VIEWPORT.width / size.width : 1;
    const jpeg: Buffer = await image.encodeJpegAsync(70);
    let text = "";
    try { text = String(await wc.executeJavaScript("document.body ? document.body.innerText : ''")).slice(0, 4000); } catch { /* page not ready */ }
    const index = history.length;
    await record?.screenshot?.(index, image);
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
      { type: "text", text: [`TASK: ${task.confirmed_task}`, `URL: ${wc.getURL()}`, `TITLE: ${wc.getTitle?.() ?? ""}`,
        `ACTIONS SO FAR (${history.length}): ${history.slice(-30).join(" | ") || "none"}`, `VISIBLE TEXT:\n${text}`].join("\n") },
    ];
    calls++;
    let reply: any;
    try { reply = await callModel({ model, max_tokens: 1024, system: SYSTEM, tools: [ACT_TOOL], tool_choice: { type: "any" }, messages: [{ role: "user", content }] }); }
    catch (error: any) { errorCode = error?.code ?? "model_error"; break; }
    usages.push({ inputTokens: reply.usage?.input_tokens ?? 0, outputTokens: reply.usage?.output_tokens ?? 0 });
    const action = parseAction((reply.content ?? []).find((b: any) => b.type === "tool_use")?.input);
    const t0 = now();
    if (!action) { history.push("invalid_action"); steps.push({ step: index, type: "invalid", status: "rejected" }); continue; }
    history.push(`${action.type} ${JSON.stringify(action).slice(0, 200)}`);
    if (action.type === "finish") { finalAnswer = action.answer; finished = true; steps.push({ step: index, type: "finish", status: "ok" }); break; }
    let status = "ok", code: string | null = null;
    try { await perform(view, action, scale); } catch (error: any) { status = "execution_uncertain"; code = error?.code ?? "execution_throw"; }
    steps.push({ step: index, type: action.type, status, errorCode: code, wallMs: now() - t0 });
    await record?.step?.(steps.at(-1));
  }
  return { history, usages, steps, finalAnswer, finished, errorCode, calls, wallMs: now() - started };
}

async function runTask(task: Task, output: string, model: string, callModel: (body: any) => Promise<any>) {
  const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
  const { openCdpView } = require("../main/harness/cdp-web-contents");
  const dir = path.join(output, task.task_id);
  await fs.mkdir(path.join(dir, "trajectory"), { recursive: true, mode: 0o700 });
  let launched: any, view: any, loop: any, errorCode: string | null = null, finalUrl = "", finalTitle = "";
  try {
    const benchProfile = process.env.HALO_BENCH_PROFILE;
    launched = await acquireCdpBrowser(benchProfile ? { headless: true, benchProfile: true, profilePath: benchProfile } : { headless: true });
    view = await openCdpView(launched.wsUrl, VIEWPORT);
    await view.webContents.loadURL(task.website);
    loop = await runLoop({ view, task, model, callModel,
      record: {
        screenshot: (i: number, image: any) => fs.writeFile(path.join(dir, "trajectory", `${String(i).padStart(4, "0")}.png`), image.toPNG(), { flag: "wx", mode: 0o600 }),
        step: (s: any) => fs.appendFile(path.join(dir, "steps.jsonl"), JSON.stringify(s) + "\n", { mode: 0o600 }),
      } });
  } catch (error: any) { errorCode = error?.code ?? "bench_error"; }
  try { finalUrl = view?.webContents.getURL() ?? ""; finalTitle = view?.webContents.getTitle?.() ?? ""; } catch { /* page already gone */ }
  errorCode = errorCode ?? loop?.errorCode ?? null;
  // Same labels as the HALO arm: a self-declared finish is "finished", a limit is "stopped:*", a captcha page wins.
  const snapshot = loop ? { state: loop.finished ? "completed" : "paused", pauseReason: loop.calls >= LIMITS.maxSteps ? "budget" : "time" } : null;
  const verdict = classify(snapshot, finalUrl, finalTitle, errorCode);
  const result = { schema_version: "online-mind2web-v2", task: task.confirmed_task, task_id: task.task_id,
    agent_final_answer: loop?.finalAnswer ?? "", reference_length: task.reference_length, action_history: loop?.history ?? [] };
  const run = { schemaVersion: 1, benchmark: "Online-Mind2Web", model, harness: "vanilla", benchProfile: "vanilla-ungated", safetyDisabled: true,
    graded: false, success: null, taskId: task.task_id, level: task.level, verdict, state: snapshot?.state ?? "startup_error",
    pauseReason: snapshot?.pauseReason ?? null, errorCode, finalUrl, wallMs: loop?.wallMs ?? 0, plannerCalls: loop?.calls ?? 0, reroutes: 0,
    usages: loop?.usages ?? [], actions: loop?.steps ?? [] };
  try {
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2), { mode: 0o600 });
  } finally {
    view?.closeConnection();
    await launched?.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify({ event: "task_finished", arm: "vanilla", taskId: task.task_id, verdict, wallMs: run.wallMs }) + "\n");
  return run;
}

async function main() {
  const dataset = process.argv[2];
  if (!dataset || !path.isAbsolute(dataset)) throw new Error("absolute_dataset_path_required");
  const via = process.env.HALO_BENCH_VIA === "claude-code" ? "claude-code" : "api";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (via === "api" && !apiKey) throw new Error("anthropic_api_key_required");
  const effort = process.env.HALO_BENCH_EFFORT || "medium";
  const callModel = via === "claude-code" ? (body: any) => callClaudeCode(body, { effort }) : (body: any) => callAnthropic(body, apiKey as string);
  const bytes = await fs.readFile(dataset);
  const unofficial = process.env.HALO_BENCH_UNOFFICIAL_TASKS === "1";
  const digest = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (!unofficial && digest !== "7dedf381531d423dc0fc48d21dc1d425655dd75f38b10211a880fa09102f257f") throw new Error("dataset_revision_mismatch");
  const model = process.env.HALO_BENCH_MODEL || "claude-haiku-5-5";
  const tasks = selectTasks(JSON.parse(bytes.toString("utf8")), process.env.HALO_BENCH_LIMIT ? Number(process.env.HALO_BENCH_LIMIT) : undefined);
  const output = process.env.HALO_BENCH_RESUME ?? await fs.mkdtemp(path.join(os.homedir(), "Downloads", "vanilla-mind2web-bench-"));
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: 1, arm: "vanilla", datasetSha256: digest, datasetSource: unofficial ? "unofficial_rebuilt_task_list" : "official", taskCount: tasks.length,
    model, via, ...(via === "claude-code" ? { effort } : {}), concurrency: 1, limits: LIMITS, viewport: VIEWPORT, graded: false, output,
    note: "no harness: no safety gates, no approver, no contract, no captcha reroute; ungraded" };
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: "bench_started", ...manifest }) + "\n");
  const tally: Record<string, number> = {};
  for (const task of tasks) {
    const done = path.join(output, task.task_id, "run.json");
    const run = await fs.access(done).then(() => true, () => false) ? JSON.parse(await fs.readFile(done, "utf8")) : await runTask(task, output, model, callModel);
    tally[run.verdict] = (tally[run.verdict] ?? 0) + 1;
  }
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify({ manifest, tally }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: "bench_finished", output, attempted: tasks.length, tally, graded: false }) + "\n");
}
module.exports = { parseAction, runLoop, callAnthropic, callClaudeCode, SYSTEM, ACT_TOOL, LIMITS };
if (require.main === module) main().catch((error: any) => { console.error(error?.message ?? "bench_failed"); process.exitCode = 1; });
