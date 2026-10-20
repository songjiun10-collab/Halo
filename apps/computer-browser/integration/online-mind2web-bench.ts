"use strict";
// Online-Mind2Web capability run. Ungraded locally: it only records trajectories; score them with the
// official judge before quoting any number. Never uploads data or submits scores.
//
// Default profile "review": permission mode "browse"; every non-read-only action goes to a human.
// Profile "open-unsafe" (only when HALO_BENCH_OPEN_UNSAFE=1): permission mode "full" and an approver that
// always allows, so the run measures raw capability without human review. Use it on public benchmark sites only. Payments stay disabled,
// and CAPTCHA / access-block pages are NOT bypassed: the host's own CAPTCHA handling is unchanged and
// such tasks are labelled blocked_by_captcha so they can be reported separately.
//
// Run: [HALO_BENCH_PROFILE=/abs/private/demo-profile] [HALO_BENCH_OPEN_UNSAFE=1] HALO_BENCH_MODEL=claude-haiku-5-5 node integration/online-mind2web-bench.ts /abs/Online_Mind2Web.json
//   HALO_BENCH_LIMIT=N      only the first N tasks (default: all)
//   HALO_BENCH_NO_GROUNDING=1 turn off the source check on answers (on by default here: an answer citing a page the run never opened is sent back)
//   HALO_BENCH_NO_GIVE_UP=1 bench only: a need_user that is not a source-checked answer is sent back, so a stuck task ends on the action/call/time limits or after HALO_BENCH_GIVE_UP_REFUSALS (default 3) send-backs
//   HALO_BENCH_CHECKLIST_MIN_SCORE=N reward scoring: submit once the weighted checklist score (0..10) reaches N, investigate more below it; hard failures (empty, gave up, blocked page) always block
//   HALO_BENCH_RESUME=<dir> continue an earlier output directory, skipping finished tasks
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const nodeCrypto = require("node:crypto");
const { performance: benchClock } = require("node:perf_hooks");
const { looksLikeCaptcha } = require("../shared/captcha-heuristics");
const { runChecklist, pageIsBlocked } = require("../main/harness/completion-checklist");

type Task = { task_id: string; confirmed_task: string; website: string; reference_length: number; level: string };
const EXPECTED_SHA = "7dedf381531d423dc0fc48d21dc1d425655dd75f38b10211a880fa09102f257f";
// HALO_BENCH_MAX_ACTIVE_MS lengthens the per-task clock (Aside's protocol is 900 s); the run records it in run.json.
const LIMITS = { maxActions: 200, maxPlannerCalls: 100, maxActiveMs: Number(process.env.HALO_BENCH_MAX_ACTIVE_MS) || 900000 };
const READ_ONLY = new Set(["navigate", "follow_link", "scroll", "observe", "record_evidence"]);
const allowAll = () => ({ decision: "allow", reasons: ["bench_open_unsafe_profile"] });
const reviewReadOnly = (d: { action: string }) => READ_ONLY.has(d.action)
  ? { decision: "allow", reasons: ["public_readonly_benchmark_scope"] }
  : { decision: "review", reasons: ["benchmark_scope_requires_human"] };
function resolveProfile(env: Record<string, string | undefined>) {
  return env.HALO_BENCH_OPEN_UNSAFE === "1"
    ? { name: "open-unsafe", safetyDisabled: true, permissionMode: "full", approve: allowAll }
    : { name: "review", safetyDisabled: false, permissionMode: "browse", approve: reviewReadOnly };
}

function selectTasks(rows: Task[], limit?: number): Task[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("task_binding_invalid");
  const ok = rows.map(row => {
    const url = new URL(row.website);
    if (url.protocol !== "https:" || url.username || url.password || !row.confirmed_task || !Number.isInteger(row.reference_length)) throw new Error("task_binding_invalid");
    return row;
  });
  return limit && limit > 0 ? ok.slice(0, limit) : ok;
}

// A CAPTCHA page is a dead end for the agent, not a puzzle to solve: step off it to another legitimate
// entry to the same site (its root, then a web search for the task), at most MAX_REROUTES times a task.
// Other search engines are separate sites with their own entry; each is tried at most once, in this order.
const SEARCH_ENGINES = [
  (q: string) => `https://search.brave.com/search?q=${q}`,
  (q: string) => `https://html.duckduckgo.com/html/?q=${q}`,
  (q: string) => `https://www.startpage.com/do/search?q=${q}`,
  (q: string) => `https://www.mojeek.com/search?q=${q}`,
];
const MAX_REROUTES = 1 + SEARCH_ENGINES.length;
function alternateRoute(task: Task, attempt: number): string | null {
  const site = new URL(task.website);
  if (attempt === 0) return site.origin + "/";
  const engine = SEARCH_ENGINES[attempt - 1];
  return engine ? engine(encodeURIComponent(`site:${site.hostname} ${task.confirmed_task}`.slice(0, 200))) : null;
}

function plannerWorker(model: string): { file: string; args: string[] } {
  const dir = path.resolve(__dirname, "../main/harness/providers");
  // "oc:<model>" runs through the user's own OpenCode login (planner calls are slow there).
  if (model.startsWith("oc:")) return { file: path.join(dir, "opencode-planner-worker.js"), args: ["--model", model.slice(3)] };
  // "vendor/model" ids (deepseek-ai/deepseek-v4.1-flash) go to the NVIDIA-hosted worker, which reads NVIDIA_API_KEY.
  if (model.includes("/")) return { file: path.join(dir, "nvidia-planner-worker.js"), args: ["--model", model] };
  return model.startsWith("claude-")
    ? { file: path.join(dir, "claude-code-worker.js"), args: ["--model", model] }
    : { file: path.join(dir, "codex-planner-worker.js"), args: ["--model", model] };
}

// An answer that admits it is incomplete or hands the choice back to the user is not a success claim.
// Heuristic on the final answer text only (Korean and English); it labels, it never changes the run.
const HEDGE = /(정해 주시|정해주시|어떻게 할까요|판단할 근거가 부족|완전한 답변을 드리기 어렵|증상은 아직 확인하지 못|which would you prefer|let me know (which|how) )/i;
function hedgedAnswer(text: string): boolean { return HEDGE.test(String(text || "")); }

// Last two host labels ("new.mta.info" and "www.mta.info" both -> "mta.info"); good enough to tell the task's site from a search engine or wiki.
function siteKey(urlOrHost: string): string {
  try { const h = urlOrHost.includes("://") ? new URL(urlOrHost).hostname : urlOrHost; return h.split(".").slice(-2).join("."); } catch { return ""; }
}

// blocked_by_captcha is decided from the final page only (URL/title heuristics the host already uses).
function classify(snapshot: any, finalUrl: string, finalTitle: string, errorCode: string | null, answered = false, blockedPage = false, unverified = false, hedged = false, siteBlocked = false, loadFailed = false): string {
  if (errorCode) return "runner_error";
  if (looksLikeCaptcha(finalUrl, finalTitle)) return "blocked_by_captcha";
  // The task's own site answered every visit with a block/error page and never once loaded: the site refused, not the agent. Counted as a failure, in its own column.
  if (siteBlocked && snapshot?.state !== "completed") return "blocked_by_site";
  // The run ended on the browser's own error page after repeated failed navigations: the page never loaded (network/protocol error), cause unproven. A failure in its own column, not "no progress".
  if (loadFailed && snapshot?.state !== "completed") return "load_failed";
  if (snapshot?.state === "completed") return unverified ? "unverified_finish" : "finished";
  // The agent declared finish but the host never confirmed the evidence: a finish claim, not a failure and not a verified success.
  if (snapshot?.state === "awaiting_verification") return unverified ? "unverified_finish" : "unconfirmed_finish";
  // A lookup answer arrives as need_user.reason; with an answer recorded the run is "answered", not stopped.
  // An answer reported from a block or error page is a blocked run, not an answered one.
  if (answered && snapshot?.pauseReason === "need_user") return blockedPage ? "blocked_report" : unverified ? "unverified_report" : hedged ? "hedged_answer" : "answered";
  return `stopped:${snapshot?.pauseReason ?? snapshot?.state ?? "unknown"}`;
}

async function runTask(task: Task, output: string, model: string, profile: ReturnType<typeof resolveProfile>) {
  const { TaskStore } = require("../main/harness/task-store");
  const { TaskController } = require("../main/harness/task-controller");
  const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");
  const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
  const { openCdpView } = require("../main/harness/cdp-web-contents");
  const dir = path.join(output, task.task_id);
  await fs.mkdir(path.join(dir, "trajectory"), { recursive: true, mode: 0o700 });
  const history: string[] = [], outcomes: any[] = [], proposals: any[] = [], usages: any[] = [];
  let launched: any, view: any, browser: any, store: any, planner: any, controller: any, timer: any;
  let reroutes = 0;
  let snapshot: any, errorCode: string | null = null, calls = 0, finalAnswer = "", finalUrl = "", finalTitle = "";
  const checklistLog: any[] = [];
  // What the task's own site did across the run: loaded fine, or only ever refused us. captchaSeen is a flag on any verdict (the run may still finish via another route).
  const taskSite = siteKey(task.website);
  let siteLoaded = false, siteRefused = false, captchaSeen = false;
  const started = benchClock.now();
  const worker = plannerWorker(model);
  try {
    const benchProfile = process.env.HALO_BENCH_PROFILE;
    // A dedicated demo profile (no personal accounts). The host still requires an absolute, owned, 0700 directory.
    // HALO_BENCH_HEADED=1 shows a real window; it needs a full Chromium binary (HALO_CHROMIUM), not headless_shell.
    const headless = process.env.HALO_BENCH_HEADED !== "1";
    launched = await acquireCdpBrowser(benchProfile ? { headless, benchProfile: true, profilePath: benchProfile } : { headless });
    view = await openCdpView(launched.wsUrl, { width: 1440, height: 900 });
    browser = new BrowserAdapter({ view, navigationTimeoutMs: 20000 });
    const execute = browser.execute.bind(browser);
    browser.execute = async (action: any, options: any) => {
      const index = history.length;
      const image = await view.webContents.capturePage();
      await fs.writeFile(path.join(dir, "trajectory", `${String(index).padStart(4, "0")}.png`), image.toPNG(), { flag: "wx", mode: 0o600 });
      const t0 = benchClock.now();
      let result: any;
      try { result = await execute(action, options); }
      catch (error: any) { result = { status: "execution_uncertain", errorCode: error?.code ?? "execution_throw" }; throw error; }
      finally {
        history.push(`${action.type} ${JSON.stringify(action).slice(0, 300)}`);
        outcomes.push({ step: index, type: action.type, status: result?.status ?? "execution_uncertain", errorCode: result?.errorCode ?? null, wallMs: benchClock.now() - t0 });
        await fs.appendFile(path.join(dir, "steps.jsonl"), JSON.stringify(outcomes.at(-1)) + "\n", { mode: 0o600 });
      }
      {
        let url = "", title = "";
        try { url = view.webContents.getURL(); title = view.webContents.getTitle?.() ?? ""; } catch { /* page gone */ }
        const route = looksLikeCaptcha(url, title) ? alternateRoute(task, reroutes) : null;
        if (route) { reroutes++; history.push(`reroute_from_captcha ${route}`); await execute({ type: "navigate", url: route }, options).catch(() => {}); }
      }
      return result;
    };
    await browser.execute({ type: "navigate", url: task.website });
    store = await TaskStore.create({ originalRequest: task.confirmed_task,
      criteria: [{ id: "benchmark", text: task.confirmed_task, required: true, verification: "user" }],
      limits: LIMITS }, { storageRoot: path.join(dir, "halo-store") });
    planner = new PlannerStdioAdapter({ command: process.execPath, args: [worker.file, ...worker.args],
      cwd: path.resolve(__dirname, ".."), timeoutMs: Number(process.env.HALO_BENCH_PLANNER_TIMEOUT_MS) || 120000, onUsage: (usage: any) => usages.push(usage) });
    controller = new TaskController({ store, browser, permissionMode: profile.permissionMode, harnessProfile: process.env.HALO_BENCH_HARNESS_PROFILE || "middle", plannerEffort: process.env.HALO_BENCH_EFFORT || "medium",
      finishEvidenceRejections: 1, repeatFailureLimit: 2,
      groundAnswers: process.env.HALO_BENCH_NO_GROUNDING !== "1",
      giveUpRefusals: process.env.HALO_BENCH_NO_GIVE_UP === "1" ? Number(process.env.HALO_BENCH_GIVE_UP_REFUSALS ?? 3) : 0,
      completionChecklist: process.env.HALO_BENCH_NO_CHECKLIST === "1" ? null : (input: any) => { const r = runChecklist({ ...input, minScore: Number(process.env.HALO_BENCH_CHECKLIST_MIN_SCORE) || null }); checklistLog.push({ call: calls, codes: r.failures.map((f: any) => f.code) }); return r; },
      approve: profile.approve, hostVerifier: () => false,
      planner: { close: () => planner.close(), next: async (context: any, options: any) => {
        calls++;
        // Measurement only: HALO_PROMPT_SIZE_LOG=<file> appends the byte size of each context part (never the content).
        if (process.env.HALO_PROMPT_SIZE_LOG) {
          try {
            const size = (v: any) => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
            const parts: Record<string, number> = {};
            for (const [k, v] of Object.entries(context)) parts[k] = size(v);
            for (const [k, v] of Object.entries(context.observation ?? {})) parts[`observation.${k}`] = size(v);
            await fs.appendFile(process.env.HALO_PROMPT_SIZE_LOG, JSON.stringify({ call: calls, total: size(context), parts }) + "\n");
          } catch { /* measurement must never affect a planning call */ }
        }
        const seen = context.observation;
        if (seen?.url) {
          if (looksLikeCaptcha(seen.url, seen.title ?? "")) captchaSeen = true;
          if (siteKey(seen.url) === taskSite) { if (pageIsBlocked(seen)) siteRefused = true; else siteLoaded = true; }
        }
        const proposal = await planner.next(context, options);
        proposals.push({ call: calls, kind: proposal.kind, actionTypes: (proposal.actions ?? []).map((a: any) => a.type) });
        // A finish carries no answer text: record that plainly (with the last real answer, if any) instead of the raw proposal JSON.
        if (proposal.kind === "finish") finalAnswer = `${finalAnswer && !finalAnswer.startsWith("[finish") ? finalAnswer + "\n" : ""}[finish without answer text; evidence ids: ${(proposal.evidenceIds ?? []).length}]`.slice(0, 4000);
        // On develop a lookup answer is delivered as need_user.reason; keep the last one so the run can be judged.
        if (proposal.kind === "need_user" && typeof proposal.reason === "string") finalAnswer = proposal.reason.slice(0, 4000);
        return proposal;
      } } });
    timer = setTimeout(() => controller.stop().catch(() => {}), LIMITS.maxActiveMs);
    snapshot = await controller.start();
  } catch (error: any) { errorCode = error?.code ?? "bench_error"; }
  finally {
    clearTimeout(timer);
    if (controller) snapshot = controller.getSnapshot();
    try { finalUrl = view?.webContents.getURL() ?? ""; finalTitle = view?.webContents.getTitle?.() ?? ""; } catch { /* page already gone */ }
    const verdict = classify(snapshot, finalUrl, finalTitle, errorCode, finalAnswer.length > 0, pageIsBlocked({ url: finalUrl, title: finalTitle }), (checklistLog[checklistLog.length - 1]?.codes.length ?? 0) > 0, hedgedAnswer(finalAnswer), siteRefused && !siteLoaded, finalUrl.startsWith("chrome-error://") && outcomes.slice(-3).length === 3 && outcomes.slice(-3).every((o: any) => o.errorCode === "navigation_error"));
    const result = { schema_version: "online-mind2web-v2", task: task.confirmed_task, task_id: task.task_id,
      agent_final_answer: finalAnswer, reference_length: task.reference_length, action_history: history };
    const run = { schemaVersion: 1, benchmark: "Online-Mind2Web", model, benchProfile: profile.name, noGiveUp: process.env.HALO_BENCH_NO_GIVE_UP === "1", groundAnswers: process.env.HALO_BENCH_NO_GROUNDING !== "1", safetyDisabled: profile.safetyDisabled, harness: "Halo", harnessProfile: process.env.HALO_BENCH_HARNESS_PROFILE || "middle",
      graded: false, success: null, taskId: task.task_id, level: task.level, verdict, state: snapshot?.state ?? "startup_error",
      pauseReason: snapshot?.pauseReason ?? null, errorCode, finalUrl, wallMs: benchClock.now() - started, plannerCalls: calls, reroutes, captchaSeen, siteRefused, siteLoaded,
      usages, budgets: snapshot?.budgets ?? null, actions: outcomes, proposals, checklist: checklistLog };
    try {
      await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2), { mode: 0o600 });
    } finally {
      await controller?.stop().catch(() => {});
      await planner?.close().catch(() => {});
      await browser?.dispose().catch(() => {});
      view?.closeConnection();
      await store?.close().catch(() => {});
      await launched?.close().catch(() => {});
    }
    process.stdout.write(JSON.stringify({ event: "task_finished", taskId: task.task_id, verdict, wallMs: run.wallMs }) + "\n");
    return run;
  }
}

async function main() {
  const dataset = process.argv[2];
  if (!dataset || !path.isAbsolute(dataset)) throw new Error("absolute_dataset_path_required");
  const bytes = await fs.readFile(dataset);
  // The official dataset is access-gated. HALO_BENCH_UNOFFICIAL_TASKS=1 accepts a task list rebuilt from
  // public sources (ids, task text, start site, level) and records that in the manifest; scores from it
  // are not leaderboard-comparable.
  const unofficial = process.env.HALO_BENCH_UNOFFICIAL_TASKS === "1";
  const digest = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (!unofficial && digest !== EXPECTED_SHA) throw new Error("dataset_revision_mismatch");
  const profile = resolveProfile(process.env);
  const model = process.env.HALO_BENCH_MODEL || "claude-haiku-5-5";
  const limit = process.env.HALO_BENCH_LIMIT ? Number(process.env.HALO_BENCH_LIMIT) : undefined;
  const tasks = selectTasks(JSON.parse(bytes.toString("utf8")), limit);
  const resume = process.env.HALO_BENCH_RESUME;
  const output = resume ?? await fs.mkdtemp(path.join(os.homedir(), "Downloads", "halo-mind2web-bench-"));
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: 1, datasetSha256: digest, datasetSource: unofficial ? "unofficial_rebuilt_task_list" : "official", taskCount: tasks.length, model, benchProfile: profile.name, safetyDisabled: profile.safetyDisabled,
    concurrency: 1, limits: LIMITS, viewport: { width: 1440, height: 900 }, graded: false,
    note: "ungraded; blocked_by_captcha tasks are reported separately, never bypassed", output };
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: "bench_started", ...manifest }) + "\n");
  const runs: any[] = [];
  for (const task of tasks) {
    const done = path.join(output, task.task_id, "run.json");
    if (await fs.access(done).then(() => true, () => false)) { runs.push(JSON.parse(await fs.readFile(done, "utf8"))); continue; }
    runs.push(await runTask(task, output, model, profile));
  }
  const tally: Record<string, number> = {};
  for (const r of runs) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  const captchaEncountered = runs.filter((r) => r.captchaSeen).length;
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify({ manifest, tally, captchaEncountered, runs }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: "bench_finished", output, attempted: runs.length, tally, captchaEncountered, graded: false }) + "\n");
}
module.exports = { siteKey, selectTasks, alternateRoute, MAX_REROUTES, plannerWorker, classify, resolveProfile, hedgedAnswer };
if (require.main === module) {
  // A run that dies mid-task used to leave no trace; print what killed it.
  process.on("uncaughtException", (error: any) => { console.error("bench_uncaught", error?.stack ?? error); process.exit(1); });
  process.on("unhandledRejection", (reason: any) => { console.error("bench_unhandled_rejection", reason?.stack ?? reason); process.exit(1); });
  process.on("exit", (code) => { if (code) console.error(`bench_exit code=${code}`); });
  main().catch((error: any) => { console.error("bench_failed", error?.stack ?? error?.message ?? error); process.exitCode = 1; });
}
