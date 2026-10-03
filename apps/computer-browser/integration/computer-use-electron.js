"use strict";

// Disposable loopback integration: task-owned screenshot -> fake planner
// image attachment -> human approval queue -> exactly one browser event.
// No real model/API call and no external network access.
const { app, BrowserWindow, WebContentsView } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { AgentViewportHost } = require("../main/harness/agent-viewport-host");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { resolveTaskProfile } = require("../shared/task-profile-router");

// A hidden-only Electron app may close its native message loop before a
// pending WebContents promise settles on macOS. Keep the integration process
// alive until the explicit result handler exits it.
const keepAlive = setInterval(() => {}, 1000);
const isolatedUserData = path.join(os.tmpdir(), `halo-cu-user-data-${process.pid}`);
app.setPath("userData", isolatedUserData);
app.on("window-all-closed", (event) => event.preventDefault());

function report(line) {
  console.log(line);
  fs.appendFileSync("/tmp/halo-computer-use-integration-2.log", `${line}\n`, { mode: 0o600 });
  if (typeof process.env.HALO_COMPUTER_USE_RESULT_PATH === "string") {
    fs.writeFileSync(process.env.HALO_COMPUTER_USE_RESULT_PATH, `${line}\n`, { mode: 0o600 });
  }
}

const html = `<!doctype html><meta charset="utf-8"><title>HALO computer-use fixture</title>
<style>html,body{margin:0;width:1440px;height:900px}button{position:absolute;left:420px;top:250px;width:220px;height:100px}</style>
<button id="target" type="button">Run harmless action</button><output id="result"></output>
<script>window.dispatchCount=0;document.getElementById('target').addEventListener('click',()=>{window.dispatchCount++;document.getElementById('result').textContent='ACTION_CONFIRMED'});</script>`;

async function main() {
  await app.whenReady();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "halo-cu-electron-"));
  const agentHost = new AgentViewportHost({
    createWindow: (options) => new BrowserWindow(options),
    createView: (options) => new WebContentsView(options),
  });
  let store, controller;
  try {
    const goalInput = { originalRequest: "As a team, click the harmless fixture button once" };
    const resolvedProfile = resolveTaskProfile({ goalInput, requestedCapabilityProfile: "multi_agent_computer_use" });
    store = await TaskStore.create(goalInput, { storageRoot, resolvedProfile });
    const adapter = agentHost.ensure(store.taskId);
    const browser = {
      observe: (...args) => adapter.observe(...args),
      execute: (...args) => adapter.execute(...args),
      setPermissionMode: (...args) => adapter.setPermissionMode(...args),
      setIntentLock: (...args) => adapter.setIntentLock(...args),
      getDocumentEpoch: (...args) => adapter.getDocumentEpoch(...args),
      captureComputerUseObservation: (observation) => agentHost.captureComputerUseObservation(store.taskId, observation),
      dispose: () => agentHost.dispose(store.taskId),
    };
    browser.setPermissionMode("interact");
    const view = agentHost._hosts.get(store.taskId).view;
    await adapter.userNavigate({ type: "navigate", url: base });
    const seen = { plannerCalls: 0, attachmentPath: null };
    controller = new TaskController({
      store,
      browser,
      permissionMode: "interact",
      approve: async () => ({ decision: "allow", reasons: ["test approval"] }),
      hostVerifier: () => true,
      planner: {
        async next(context, options) {
          seen.plannerCalls += 1;
          if (seen.plannerCalls > 1) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] };
          assert.equal(context.observation.computerUse.taskId, store.taskId);
          assert.equal(context.observation.computerUse.agentId, null);
          assert.equal(JSON.stringify(context).includes("/observation.png"), false);
          assert.equal(options.attachments.length, 1);
          seen.attachmentPath = options.attachments[0].path;
          assert.equal(fs.statSync(seen.attachmentPath).mode & 0o777, 0o600);
          return {
            taskId: context.taskId,
            goalVersion: context.goalVersion,
            basedOnObservationId: context.observation.id,
            criterionIds: [],
            kind: "actions",
            actions: [{ type: "click_at", observationId: context.observation.id, x: 0.37, y: 0.33 }],
          };
        },
      },
    });
    await controller.start();
    const [approval] = controller.getSnapshot().approvalQueue;
    assert.ok(approval, JSON.stringify(controller.getSnapshot()));
    assert.equal(controller.getSnapshot().state, "awaiting_approval");
    assert.equal(await view.webContents.executeJavaScript("window.dispatchCount"), 0, "proposal alone must not dispatch");
    await controller.approve(approval.id);
    const dispatchCount = await view.webContents.executeJavaScript("window.dispatchCount");
    assert.equal(dispatchCount, 1);
    assert.equal(await view.webContents.executeJavaScript("document.getElementById('result').textContent"), "ACTION_CONFIRMED");
    assert.equal(fs.existsSync(seen.attachmentPath), false, "private image is deleted after the planner turn");
    return { realElectron: true, loopbackOnly: true, profile: "multi_agent_computer_use", plannerCalls: seen.plannerCalls, approval: "parent-human-queue", dispatchCount: 1, screenshotCleanup: "verified" };
  } finally {
    await controller?.stop().catch(() => {});
    await agentHost.disposeAll();
    await store?.close().catch(() => {});
    await fs.promises.rm(storageRoot, { recursive: true, force: true });
    await fs.promises.rm(isolatedUserData, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then((result) => { clearInterval(keepAlive); report(`RESULT_JSON:${JSON.stringify(result)}`); app.exit(0); })
  .catch((error) => { clearInterval(keepAlive); report(`ERROR:${error?.stack ?? String(error)}`); app.exit(1); });
