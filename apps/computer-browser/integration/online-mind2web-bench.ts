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
// Run: [HALO_BENCH_OPEN_UNSAFE=1] HALO_BENCH_MODEL=claude-haiku-5-5 node integration/online-mind2web-bench.ts /abs/Online_Mind2Web.json
//   HALO_BENCH_LIMIT=N      only the first N tasks (default: all)
//   HALO_BENCH_RESUME=<dir> continue an earlier output directory, skipping finished tasks
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const nodeCrypto = require("node:crypto");
const { performance: benchClock } = require("node:perf_hooks");
const { looksLikeCaptcha } = require("../shared/captcha-heuristics");

type Task = { task_id: string; confirmed_task: string; website: string; reference_length: number; level: string };
const EXPECTED_SHA = "7dedf381531d423dc0fc48d21dc1d425655dd75f38b10211a880fa09102f257f";
const LIMITS = { maxActions: 200, maxPlannerCalls: 100, maxActiveMs: 900000 };
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

function plannerWorker(model: string): { file: string; args: string[] } {
  const dir = path.resolve(__dirname, "../main/harness/providers");
  return model.startsWith("claude-")
    ? { file: path.join(dir, "claude-code-worker.js"), args: ["--model", model] }
    : { file: path.join(dir, "codex-planner-worker.js"), args: ["--model", model] };
}

// blocked_by_captcha is decided from the final page only (URL/title heuristics the host already uses).
function classify(snapshot: any, finalUrl: string, finalTitle: string, errorCode: string | null): string {
  if (errorCode) return "runner_error";
  if (looksLikeCaptcha(finalUrl, finalTitle)) return "blocked_by_captcha";
  if (snapshot?.state === "completed") return "finished";
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
  let snapshot: any, errorCode: string | null = null, calls = 0, finalAnswer = "", finalUrl = "", finalTitle = "";
  const started = benchClock.now();
  const worker = plannerWorker(model);
  try {
    launched = await acquireCdpBrowser({ headless: true });
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
      return result;
    };
    await browser.execute({ type: "navigate", url: task.website });
    store = await TaskStore.create({ originalRequest: task.confirmed_task,
      criteria: [{ id: "benchmark", text: task.confirmed_task, required: true, verification: "user" }],
      limits: LIMITS }, { storageRoot: path.join(dir, "halo-store") });
    planner = new PlannerStdioAdapter({ command: process.execPath, args: [worker.file, ...worker.args],
      cwd: path.resolve(__dirname, ".."), timeoutMs: 120000, onUsage: (usage: any) => usages.push(usage) });
    controller = new TaskController({ store, browser, permissionMode: profile.permissionMode, harnessProfile: "middle", plannerEffort: "medium",
      approve: profile.approve, hostVerifier: () => false,
      planner: { close: () => planner.close(), next: async (context: any, options: any) => {
        calls++;
        const proposal = await planner.next(context, options);
        proposals.push({ call: calls, kind: proposal.kind, actionTypes: (proposal.actions ?? []).map((a: any) => a.type) });
        if (proposal.kind === "finish") finalAnswer = JSON.stringify(proposal).slice(0, 4000);
        return proposal;
      } } });
    timer = setTimeout(() => controller.stop().catch(() => {}), LIMITS.maxActiveMs);
    snapshot = await controller.start();
  } catch (error: any) { errorCode = error?.code ?? "bench_error"; }
  finally {
    clearTimeout(timer);
    if (controller) snapshot = controller.getSnapshot();
    try { finalUrl = view?.webContents.getURL() ?? ""; finalTitle = view?.webContents.getTitle?.() ?? ""; } catch { /* page already gone */ }
    const verdict = classify(snapshot, finalUrl, finalTitle, errorCode);
    const result = { schema_version: "online-mind2web-v2", task: task.confirmed_task, task_id: task.task_id,
      agent_final_answer: finalAnswer, reference_length: task.reference_length, action_history: history };
    const run = { schemaVersion: 1, benchmark: "Online-Mind2Web", model, benchProfile: profile.name, safetyDisabled: profile.safetyDisabled, harness: "Halo",
      graded: false, success: null, taskId: task.task_id, level: task.level, verdict, state: snapshot?.state ?? "startup_error",
      pauseReason: snapshot?.pauseReason ?? null, errorCode, finalUrl, wallMs: benchClock.now() - started, plannerCalls: calls,
      usages, budgets: snapshot?.budgets ?? null, actions: outcomes, proposals };
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
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify({ manifest, tally, runs }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: "bench_finished", output, attempted: runs.length, tally, graded: false }) + "\n");
}
module.exports = { selectTasks, plannerWorker, classify, resolveProfile };
if (require.main === module) main().catch((error: any) => { console.error(error?.message ?? "bench_failed"); process.exitCode = 1; });
