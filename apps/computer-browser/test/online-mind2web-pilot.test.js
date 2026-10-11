"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { selectPilotTasks, readOnlyDecision, actionStep, captureTerminalEvidence } = require("../integration/online-mind2web-pilot.ts");

const ids = ["ade4c09ad3fdb1607209750924cd232f", "fb7b4f784cfde003e2548fdf4e8d6b4f", "b320c68bffc1f3c7f2a8dc9d5478fb27", "4091bdd3fa64a5b0d912bc08eaf9c824", "d71be72aa25c3eab8eea47a0e60382e2"];
test("pilot refuses missing or duplicate task bindings rather than silently substituting tasks", () => {
  const rows = ids.map(task_id => ({ task_id, confirmed_task: "Read public information", website: "https://example.test/", reference_length: 4, level: "easy" }));
  assert.deepEqual(selectPilotTasks(rows).map(t => t.task_id), ids);
  assert.throws(() => selectPilotTasks(rows.slice(1)), /task_binding/);
  assert.throws(() => selectPilotTasks([...rows, rows[0]]), /task_binding/);
  assert.throws(() => selectPilotTasks(rows.map((r,i) => i ? r : {...r, website:"file:///etc/passwd"})), /task_binding/);
});
test("benchmark approver does not approve input, clicks, credential or MCP capabilities", () => {
  for (const action of ["click", "type", "submit", "mcp_propose", "credential_autofill", "press_key", "unknown"]) {
    assert.equal(readOnlyDecision({action}).decision, "review");
  }
  for (const action of ["navigate", "follow_link", "scroll", "observe", "record_evidence"]) assert.equal(readOnlyDecision({action}).decision, "allow");
});
test("factual step binds its screenshot, pre-action URL and outcome without treating uncertainty as success", () => {
  const step = actionStep(2, {type:"navigate",url:"https://example.test/done"}, "https://example.test/start", {status:"ok"});
  assert.equal(step.step, 2);
  assert.equal(step.screenshot, "trajectory/0002.png");
  assert.equal(step.url, "https://example.test/start");
  assert.equal(step.thought, null);
  assert.match(step.action, /NAVIGATE.*SUCCESS/);
  const uncertain = actionStep(3, {type:"follow_link",elementId:"e1"}, "https://example.test/start", {status:"execution_uncertain"});
  assert.doesNotMatch(uncertain.action, /SUCCESS/);
  assert.equal(uncertain.action_status, undefined);
  const failed = actionStep(4, {type:"navigate",url:"https://example.test/"}, "about:blank", {status:"failed",errorCode:"navigation_failed"});
  assert.equal(failed.action_status, "FAILED");
});
test("terminal evidence preserves the final page screenshot and bounded page identity", async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"halo-terminal-evidence-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,"trajectory"));
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  const view={webContents:{capturePage:async()=>({toPNG:()=>png,getSize:()=>({width:1440,height:900})}),
    getURL:()=>"https://example.test/specs",getTitle:()=>"Product Specs"}};
  const result=await captureTerminalEvidence(view,dir,{state:"paused",pauseReason:"need_user"});
  assert.equal(result.screenshot,"trajectory/final.png");
  assert.equal(result.url,"https://example.test/specs");
  assert.equal(result.title,"Product Specs");
  assert.equal(result.state,"paused");
  assert.deepEqual(await fs.readFile(path.join(dir,"trajectory","final.png")),png);
});

test("actionStep records every action the full scope permits (find/zoom/select_all/hw_step must not throw)", () => {
  const url = "https://example.test/";
  const find = actionStep(1, { type: "find", text: "Contact us" }, url, { status: "ok" });
  assert.match(find.action, /FIND -> text Contact us \| SUCCESS/);
  assert.match(actionStep(2, { type: "zoom", level: 2 }, url, { status: "ok" }).action, /ZOOM/);
  assert.match(actionStep(3, { type: "select_all" }, url, { status: "ok" }).action, /SELECT/);
  const hw = actionStep(4, { type: "hw_step", step: { op: "fill", locator: { label: "Email" }, text: "a" } }, url, { status: "ok" });
  assert.match(hw.action, /TYPE -> fill/);
});
