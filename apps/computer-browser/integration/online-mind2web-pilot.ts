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
function actionStep(index: number, action: any, beforeUrl: string, result: any) {
  const verb = {navigate:"NAVIGATE",follow_link:"CLICK",scroll:"SCROLL",observe:"WAIT"}[action.type as string];
  if (!verb) throw new Error("unsupported_factual_action");
  const status = result?.status === "ok" ? "SUCCESS" : ["error","failed"].includes(result?.status) ? "FAILED" : undefined;
  const detail = action.type === "navigate" ? action.url : action.type === "follow_link" ? `element ${action.elementId}` : action.type === "scroll" ? `${action.direction} ${action.amount}` : "observe current page";
  return { step:index, action:`page -> ${verb} -> ${detail}${verb !== "WAIT" && status ? ` | ${status}` : ""}`,
    thought:null, screenshot:`trajectory/${String(index).padStart(4,"0")}.png`, url:beforeUrl,
    ...(verb !== "WAIT" && status ? {action_status:status} : {}) };
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
  let launched: any, view: any, browser: any, store: any, planner: any, controller: any, timer: any;
  let calls = 0, contextBytes = 0, peakHostRss = 0;
  const usages: any[] = [];
  const started = benchClock.now();
  let snapshot: any, errorCode: string | null = null;
  let recordingError = false;
  const recordExecution = async (action: any, invoke: () => Promise<any>) => {
    if (!READ_ONLY.has(action.type) || action.type === "record_evidence") throw new Error("benchmark_scope_denied");
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
    launched = await acquireCdpBrowser({headless:true});
    view = await openCdpView(launched.wsUrl,{width:1440,height:900});
    browser = new BrowserAdapter({view,navigationTimeoutMs:20000});
    const execute = browser.execute.bind(browser);
    browser.execute = (action: any, options: any) => recordExecution(action,()=>execute(action,options));
    // Bootstrap is factual but separate from controller-charged actions; official start URL, no search shortcut.
    await browser.execute({type:"navigate",url:task.website});
    store = await TaskStore.create({originalRequest:task.confirmed_task,
      criteria:[{id:"benchmark",text:task.confirmed_task,required:true,verification:"user"}],
      limits:{maxActions:50,maxPlannerCalls:25,maxActiveMs:180000}}, {storageRoot:path.join(dir,"halo-store")});
    planner = new PlannerStdioAdapter({command:process.execPath,
      args:[path.resolve(__dirname,"../main/harness/providers/codex-planner-worker.js"),"--model","gpt-6-luna"],
      cwd:path.resolve(__dirname,".."),timeoutMs:60000,onUsage:(usage: any)=>usages.push(usage)});
    controller = new TaskController({store,browser,permissionMode:"browse",harnessProfile:"middle",plannerEffort:"medium",
      approve:readOnlyDecision,hostVerifier:()=>false,
      planner:{close:()=>planner.close(),next:async(context: any, options: any)=>{
        calls++; contextBytes += Buffer.byteLength(JSON.stringify(context));
        peakHostRss=Math.max(peakHostRss,process.memoryUsage().rss);
        const proposal=await planner.next(context,options);
        proposals.push({call:calls,kind:proposal.kind,actionTypes:(proposal.actions??[]).map((a:any)=>a.type)});
        return proposal;
      }}});
    timer=setTimeout(()=>controller.stop().catch(()=>{}),180000);
    snapshot=await controller.start();
  } catch(error:any) { errorCode=error?.code ?? "pilot_error"; }
  finally {
    clearTimeout(timer);
    if (controller) snapshot=controller.getSnapshot();
    const result={schema_version:"online-mind2web-v2",task:task.confirmed_task,task_id:task.task_id,
      agent_final_answer:"",reference_length:task.reference_length,action_history:actions};
    const run={schemaVersion:1,benchmark:"Online-Mind2Web",model:"gpt-6-luna",harness:"Halo",graded:false,success:null,
      taskId:task.task_id,state:snapshot?.state??"startup_error",pauseReason:snapshot?.pauseReason??null,errorCode,
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
  const manifest={schemaVersion:1,datasetSha256:EXPECTED_SHA,taskIds:tasks.map(t=>t.task_id),model:"gpt-6-luna",
    effort:"medium",concurrency:1,timeoutMs:180000,maxPlannerCalls:25,maxActions:50,viewport:{width:1440,height:900},
    graded:false,scope:"five selected public read-only tasks; not a representative full-benchmark score",output};
  await fs.writeFile(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600});
  process.stdout.write(JSON.stringify({event:"pilot_started",...manifest})+"\n");
  const runs=[];
  for(const task of tasks) runs.push(await runTask(task,output));
  await fs.writeFile(path.join(output,"summary.json"),JSON.stringify({manifest,runs},null,2),{mode:0o600});
  process.stdout.write(JSON.stringify({event:"pilot_finished",output,attempted:runs.length,graded:false})+"\n");
}
module.exports={selectPilotTasks,readOnlyDecision,actionStep};
if(require.main===module) main().catch((error:any)=>{console.error(error?.message??"pilot_failed");process.exitCode=1;});
