"use strict";
// Local, ungraded public-benchmark pilot. Never uploads data or submits scores.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const nodeCrypto = require("node:crypto");
const { performance: benchClock } = require("node:perf_hooks");
type Task = { task_id: string; confirmed_task: string; website: string; reference_length: number; level: string };
const PILOT_IDS = ["ade4c09ad3fdb1607209750924cd232f", "fb7b4f784cfde003e2548fdf4e8d6b4f", "b320c68bffc1f3c7f2a8dc9d5478fb27", "4091bdd3fa64a5b0d912bc08eaf9c824", "d71be72aa25c3eab8eea47a0e60382e2"];
const EXPECTED_SHA = "7dedf381531d423dc0fc48d21dc1d425655dd75f38b10211a880fa09102f257f";
const READ_ONLY = new Set(["navigate", "follow_link", "scroll", "observe", "record_evidence"]);
// Everything the product's Full permission mode permits the planner to try,
// plus the journaling-only record_evidence. submit_form is included because
// FULL_ACTIONS has it; download is not (the policy denies it).
const FULL_SCOPE_ACTIONS = new Set(["navigate", "follow_link", "scroll", "observe", "click", "type", "click_at", "type_at", "press_key", "submit_form", "record_evidence"]);
// Benchmark scope. "readonly" is the default and the only mode that acts
// without side effects. "full" mirrors the product's Full permission mode so a
// model is not judged on a constraint it never sees in the product -- but it
// means the agent really does click and type on live public pages, so it needs
// an explicit HALO_PILOT_SCOPE=full. The scope and permission mode are
// recorded in manifest.json and every run.json.
const PILOT_SCOPE = process.env.HALO_PILOT_SCOPE === "full" ? "full" : "readonly";
const PERMITTED_ACTIONS = PILOT_SCOPE === "full" ? FULL_SCOPE_ACTIONS : READ_ONLY;
const PERMISSION_MODE = PILOT_SCOPE === "full" ? "full" : "browse";
// Provider selection. The default stays the Codex worker so results remain
// comparable with earlier runs; HALO_PILOT_PROVIDER=nvidia switches to the
// NVIDIA worker. The NVIDIA key is read from the app's own key store (never
// from argv, never written to an artifact) unless NVIDIA_API_KEY is already in
// the environment.
const PILOT_PROVIDER = process.env.HALO_PILOT_PROVIDER === "nvidia" ? "nvidia" : "codex";
const PILOT_MODEL = process.env.HALO_PILOT_MODEL || (PILOT_PROVIDER === "nvidia" ? "deepseek-ai/deepseek-v4.1-flash" : "gpt-6-luna");
// Per-task active budget in ms; the value actually used is recorded in both
// run.json and manifest.json. A slow model can need more wall time than the
// Codex default, and comparing runs across models requires knowing this number.
const PILOT_MAX_ACTIVE_MS = Number(process.env.HALO_PILOT_MAX_ACTIVE_MS) > 0 ? Number(process.env.HALO_PILOT_MAX_ACTIVE_MS) : 180000;

async function plannerLaunch() {
  if (PILOT_PROVIDER !== "nvidia") return { worker: path.resolve(__dirname, "../main/harness/providers/codex-planner-worker.js"), env: undefined };
  let key = process.env.NVIDIA_API_KEY;
  if (!key) {
    const { createKeychainStorage } = require("../main/harness/chromium-keychain");
    const { ApiKeyStore } = require("../main/harness/api-key-store");
    const store = new ApiKeyStore({ storageRoot: path.join(os.homedir(), "Library/Application Support/halo-computer-browser/harness-data"), safeStorage: createKeychainStorage() });
    await store.load();
    key = store.env().NVIDIA_API_KEY;
  }
  if (!key) throw new Error("nvidia_api_key_unavailable");
  return { worker: path.resolve(__dirname, "../main/harness/providers/nvidia-planner-worker.js"), env: { NVIDIA_API_KEY: key } };
}

function selectPilotTasks(rows: Task[]): Task[] {
  if (!Array.isArray(rows)) throw new Error("task_binding_invalid");
  return PILOT_IDS.map(id => {
    const found = rows.filter(row => row.task_id === id);
    if (found.length !== 1) throw new Error("task_binding_missing_or_duplicate");
    const row = found[0];
    const url = new URL(row.website);
    if (url.protocol !== "https:" || url.username || url.password || !row.confirmed_task || !Number.isInteger(row.reference_length)) throw new Error("task_binding_invalid");
    return row;
  });
}
function readOnlyDecision(descriptor: {action: string}) {
  return READ_ONLY.has(descriptor.action)
    ? { decision: "allow", reasons: ["public_readonly_benchmark_scope"] }
    : { decision: "review", reasons: ["benchmark_scope_requires_human"] };
}
// The approver actually wired into the controller: allow-lists exactly the
// actions the selected scope permits; anything else still goes to a human
// rather than failing open.
function pilotDecision(descriptor: {action: string}) {
  return PERMITTED_ACTIONS.has(descriptor.action)
    ? { decision: "allow", reasons: [`public_benchmark_${PILOT_SCOPE}_scope`] }
    : { decision: "review", reasons: ["benchmark_scope_requires_human"] };
}
function actionStep(index: number, action: any, beforeUrl: string, result: any) {
  const verb = {navigate:"NAVIGATE",follow_link:"CLICK",scroll:"SCROLL",observe:"WAIT",
    click:"CLICK",click_at:"CLICK",type:"TYPE",type_at:"TYPE",press_key:"PRESS",submit_form:"SUBMIT"}[action.type as string];
  if (!verb) throw new Error("unsupported_factual_action");
  const status = result?.status === "ok" ? "SUCCESS" : ["error","failed"].includes(result?.status) ? "FAILED" : undefined;
  const detail = action.type === "navigate" ? action.url
    : ["follow_link","click","type","submit_form"].includes(action.type) ? `element ${action.elementId ?? "?"}`
    : ["click_at","type_at"].includes(action.type) ? `at ${action.x},${action.y}`
    : action.type === "press_key" ? `key ${String(action.key ?? "?").slice(0,24)}`
    : action.type === "scroll" ? `${action.direction} ${action.amount}` : "observe current page";
  return { step:index, action:`page -> ${verb} -> ${detail}${verb !== "WAIT" && status ? ` | ${status}` : ""}`,
    thought:null, screenshot:`trajectory/${String(index).padStart(4,"0")}.png`, url:beforeUrl,
    ...(verb !== "WAIT" && status ? {action_status:status} : {}) };
}

async function captureTerminalEvidence(view: any, dir: string, snapshot: any) {
  if (!view?.webContents || typeof view.webContents.capturePage !== "function") return { captureError: "terminal_capture_unavailable" };
  try {
    const image = await view.webContents.capturePage();
    if (!image || typeof image.toPNG !== "function" || typeof image.getSize !== "function") throw new Error("terminal_capture_invalid");
    const png = image.toPNG();
    const size = image.getSize();
    if (!Buffer.isBuffer(png) || png.length === 0 || png.length > 20 * 1024 * 1024 ||
        !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 ||
        size.width > 4096 || size.height > 4096) throw new Error("terminal_capture_invalid");
    await fs.writeFile(path.join(dir,"trajectory","final.png"),png,{flag:"wx",mode:0o600});
    return { screenshot:"trajectory/final.png", url:String(view.webContents.getURL?.()??"").slice(0,4096),
      title:String(view.webContents.getTitle?.()??"").slice(0,512), width:size.width,height:size.height,
      state:snapshot?.state??null,pauseReason:snapshot?.pauseReason??null };
  } catch (error: any) {
    return { captureError:"terminal_capture_failed",state:snapshot?.state??null,
      pauseReason:snapshot?.pauseReason??null };
  }
}

async function runTask(task: Task, output: string) {
  const { TaskStore } = require("../main/harness/task-store");
  const { TaskController } = require("../main/harness/task-controller");
  const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");
  const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
  const { openCdpView } = require("../main/harness/cdp-web-contents");
  const dir = path.join(output, task.task_id);
  await fs.mkdir(path.join(dir,"trajectory"), {recursive:true,mode:0o700});
  const actions: any[] = [], outcomes: any[] = [], proposals: any[] = [];
  let launched: any, view: any, browser: any, store: any, planner: any, controller: any, timer: any, launch: any;
  let calls = 0, contextBytes = 0, peakHostRss = 0;
  const usages: any[] = [];
  const started = benchClock.now();
  let snapshot: any, terminalProposal: any = null, terminalEvidence: any = null, errorCode: string | null = null;
  let recordingError = false;
  const recordExecution = async (action: any, invoke: () => Promise<any>) => {
    if (!PERMITTED_ACTIONS.has(action.type)) throw new Error("benchmark_scope_denied");
    const index = actions.length;
    const before = view.webContents.getURL();
    // Fail closed: a missing screenshot must not silently create an unrecorded action.
    const image = await view.webContents.capturePage();
    await fs.writeFile(path.join(dir,"trajectory",`${String(index).padStart(4,"0")}.png`), image.toPNG(), {flag:"wx",mode:0o600});
    const t0 = benchClock.now();
    let result: any;
    try { result = await invoke(); }
    catch (error: any) { result = {status:"execution_uncertain",errorCode:error?.code ?? "execution_throw"}; throw error; }
    finally {
      const step = actionStep(index,action,before,result);
      actions.push(step);
      outcomes.push({step:index,status:result?.status ?? "execution_uncertain",errorCode:result?.errorCode ?? null,wallMs:benchClock.now()-t0});
      try { await fs.appendFile(path.join(dir,"steps.jsonl"), JSON.stringify({ ...step, outcome:outcomes.at(-1) })+"\n", {mode:0o600}); }
      catch (error) { recordingError = true; throw error; }
    }
    return result;
  };
  try {
    launch = await plannerLaunch();
    launched = await acquireCdpBrowser({headless:true});
    view = await openCdpView(launched.wsUrl,{width:1440,height:900});
    browser = new BrowserAdapter({view,navigationTimeoutMs:20000});
    const execute = browser.execute.bind(browser);
    browser.execute = (action: any, options: any) => recordExecution(action,()=>execute(action,options));
    // Bootstrap is factual but separate from controller-charged actions; official start URL, no search shortcut.
    await browser.execute({type:"navigate",url:task.website});
    store = await TaskStore.create({originalRequest:task.confirmed_task,
      criteria:[{id:"benchmark",text:task.confirmed_task,required:true,verification:"user"}],
      limits:{maxActions:50,maxPlannerCalls:25,maxActiveMs:PILOT_MAX_ACTIVE_MS}}, {storageRoot:path.join(dir,"halo-store")});
    planner = new PlannerStdioAdapter({command:process.execPath,
      args:[launch.worker,"--model",PILOT_MODEL],
      ...(launch.env ? {env:launch.env} : {}),
      cwd:path.resolve(__dirname,".."),timeoutMs:60000,onUsage:(usage: any)=>usages.push(usage)});
    controller = new TaskController({store,browser,permissionMode:PERMISSION_MODE,harnessProfile:"middle",plannerEffort:"medium",
      approve:pilotDecision,hostVerifier:()=>false,
      planner:{close:()=>planner.close(),next:async(context: any, options: any)=>{
        calls++; contextBytes += Buffer.byteLength(JSON.stringify(context));
        peakHostRss=Math.max(peakHostRss,process.memoryUsage().rss);
        const proposal=await planner.next(context,options);
        proposals.push({call:calls,kind:proposal.kind,actionTypes:(proposal.actions??[]).map((a:any)=>a.type)});
        if (proposal.kind === "finish" || proposal.kind === "need_user") terminalProposal = proposal;
        return proposal;
      }}});
    timer=setTimeout(()=>controller.stop().catch(()=>{}),PILOT_MAX_ACTIVE_MS+5000);
    snapshot=await controller.start();
  } catch(error:any) { errorCode=error?.code ?? "pilot_error"; }
  finally {
    clearTimeout(timer);
    if (controller) snapshot=controller.getSnapshot();
    if (view) terminalEvidence = await captureTerminalEvidence(view,dir,snapshot);
    const finalAnswer = typeof snapshot?.needUserReason === "string" ? snapshot.needUserReason.slice(0,2000) : "";
    const result={schema_version:"online-mind2web-v2",task:task.confirmed_task,task_id:task.task_id,
      agent_final_answer:finalAnswer,reference_length:task.reference_length,action_history:actions};
    const run={schemaVersion:1,benchmark:"Online-Mind2Web",model:PILOT_MODEL,plannerProvider:PILOT_PROVIDER,benchmarkScope:PILOT_SCOPE,permissionMode:PERMISSION_MODE,maxActiveMs:PILOT_MAX_ACTIVE_MS,harness:"Halo",graded:false,success:null,
      taskId:task.task_id,state:snapshot?.state??"startup_error",pauseReason:snapshot?.pauseReason??null,errorCode,
      terminalProposal:terminalProposal?{kind:terminalProposal.kind,evidenceIds:terminalProposal.evidenceIds??[],...(terminalProposal.kind==="need_user"?{reason:finalAnswer}:{})}:null,
      terminalEvidence,
      recordingError,wallMs:benchClock.now()-started,plannerCalls:calls,contextBytes,
      peakHostRssBytes:peakHostRss,rssScope:"runner only; excludes Chromium and model worker",usages,
      budgets:snapshot?.budgets??null,approvalQueueLength:snapshot?.approvalQueue?.length??0,
      bootstrapActions:1,actions:outcomes,proposals};
    try {
      await fs.writeFile(path.join(dir,"result.json"),JSON.stringify(result,null,2),{mode:0o600});
      await fs.writeFile(path.join(dir,"run.json"),JSON.stringify(run,null,2),{mode:0o600});
    } finally {
      await controller?.stop().catch(()=>{});
      await planner?.close().catch(()=>{});
      await browser?.dispose().catch(()=>{});
      view?.closeConnection();
      await store?.close().catch(()=>{});
      await launched?.close().catch(()=>{});
    }
    process.stdout.write(JSON.stringify({event:"task_finished",...run})+"\n");
    return run;
  }
}

async function main() {
  const dataset=process.argv[2];
  if (!dataset || !path.isAbsolute(dataset)) throw new Error("absolute_dataset_path_required");
  const bytes=await fs.readFile(dataset);
  if (nodeCrypto.createHash("sha256").update(bytes).digest("hex")!==EXPECTED_SHA) throw new Error("dataset_revision_mismatch");
  const tasks=selectPilotTasks(JSON.parse(bytes.toString("utf8")));
  const output=await fs.mkdtemp(path.join(os.homedir(),"Downloads","halo-online-mind2web-"));
  await fs.chmod(output,0o700);
  const manifest={schemaVersion:1,datasetSha256:EXPECTED_SHA,taskIds:tasks.map(t=>t.task_id),model:PILOT_MODEL,plannerProvider:PILOT_PROVIDER,
    benchmarkScope:PILOT_SCOPE,permissionMode:PERMISSION_MODE,
    effort:"medium",concurrency:1,timeoutMs:PILOT_MAX_ACTIVE_MS,maxPlannerCalls:25,maxActions:50,viewport:{width:1440,height:900},
    graded:false,scope:PILOT_SCOPE === "full"
      ? "five selected public tasks run with the product's Full permission mode: the agent clicks and types on live public pages. Not a representative full-benchmark score."
      : "five selected public read-only tasks; not a representative full-benchmark score",output};
  await fs.writeFile(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600});
  process.stdout.write(JSON.stringify({event:"pilot_started",...manifest})+"\n");
  const runs=[];
  // Real sites see this machine's one IP: space the tasks out so a pilot never reads as a burst.
  const gapMs=Number(process.env.HALO_PILOT_GAP_MS)>=0&&process.env.HALO_PILOT_GAP_MS!==undefined?Number(process.env.HALO_PILOT_GAP_MS):30000;
  for(const [i,task] of tasks.entries()){
    if(i>0&&gapMs>0) await new Promise((resolve)=>setTimeout(resolve,gapMs));
    runs.push(await runTask(task,output));
  }
  await fs.writeFile(path.join(output,"summary.json"),JSON.stringify({manifest,runs},null,2),{mode:0o600});
  process.stdout.write(JSON.stringify({event:"pilot_finished",output,attempted:runs.length,graded:false})+"\n");
}
module.exports={selectPilotTasks,readOnlyDecision,pilotDecision,actionStep,captureTerminalEvidence};
if(require.main===module) main().catch((error:any)=>{console.error(error?.message??"pilot_failed");process.exitCode=1;});
