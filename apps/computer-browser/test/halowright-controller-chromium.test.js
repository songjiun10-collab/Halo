"use strict";

// Halowright through the whole stack on a real Chromium page: a planner proposes hw_step actions, TaskController
// gates and approves them, BrowserAdapter resolves the locators and sends real input, and the page really changes.
// Skipped unless a Chromium binary is found (HALO_CHROMIUM or the local trial build).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const CHROMIUM = [
  process.env.HALO_CHROMIUM,
  path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"),
  path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"),
].find((candidate) => candidate && fs.existsSync(candidate));

const PAGE = `<!doctype html><title>Signup</title>
<h1>Newsletter</h1>
<label for="email">Email address</label><input id="email" type="email">
<label for="plan">Plan</label><select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
<div id="slot"></div><p id="result"></p>
<script>
// The submit button is rendered late and starts disabled: a locator must wait for it to become actionable.
setTimeout(() => {
  const button = document.createElement("button");
  button.textContent = "Subscribe"; button.disabled = true;
  button.onclick = () => { document.getElementById("result").textContent = "Subscribed: " + document.getElementById("email").value + " / " + document.getElementById("plan").value; };
  document.getElementById("slot").appendChild(button);
  setTimeout(() => { button.disabled = false; }, 400);
}, 300);
</script>`;

test("real Chromium: TaskController drives a form through planner hw_step proposals", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(PAGE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-hwc-"));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "halo-hwc-store-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  let store;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await store?.close().catch(() => {});
    await new Promise((resolve) => { chrome.once("exit", resolve); chrome.kill("SIGTERM"); setTimeout(resolve, 5000); });
    await new Promise((resolve) => server.close(resolve));
    for (const dir of [profile, storageRoot]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 900, height: 600 });
  const adapter = new BrowserAdapter({ view, permissionMode: "full", taskId: "hw-task" });
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/` })).status, "ok");

  const script = [
    { type: "hw_step", step: { op: "fill", locator: { label: "Email address" }, text: "a@b.co" } },
    { type: "hw_step", step: { op: "select", locator: { label: "Plan" }, value: "pro" } },
    { type: "hw_step", step: { op: "click", locator: { role: "button", name: "Subscribe" } } },
  ];
  const approvals = [];
  const planner = { next: async (context) => {
    const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
    const action = script.shift();
    return action ? { ...base, kind: "actions", actions: [action] } : { ...base, kind: "need_user", reason: "form submitted" };
  } };
  store = await TaskStore.create({ originalRequest: "subscribe a@b.co to the Pro plan" }, { storageRoot });
  const controller = new TaskController({
    store, planner, browser: adapter, hostVerifier: () => true, observeRetryDelayMs: 1,
    approve: async (request) => { approvals.push(request); return { decision: "allow", reasons: [] }; },
  });
  // A label-only locator is never auto-run: the controller parks it for the person, who approves it here.
  let snapshot = await controller.start();
  let human = 0;
  while (snapshot.state === "awaiting_approval" && human < 6) {
    human += 1;
    snapshot = await controller.approve(snapshot.approvalQueue[0].id);
  }
  assert.ok(human >= 1, "the label-only fill went through human approval");
  assert.equal(snapshot.pauseReason, "need_user", JSON.stringify(snapshot).slice(0, 600));
  assert.equal(script.length, 0, "every proposed hw_step was executed");
  const result = await view.webContents.executeJavaScript("document.getElementById('result').textContent");
  assert.equal(result, "Subscribed: a@b.co / pro");
  // The planner must be able to see that a select landed, or it repeats the step (seen with a real model).
  const observed = await adapter.observe();
  const dropdown = (observed.elements ?? []).find((element) => element.role === "combobox");
  assert.equal(dropdown?.value, "Pro");
});
