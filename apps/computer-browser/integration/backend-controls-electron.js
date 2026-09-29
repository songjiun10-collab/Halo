"use strict";

// Real Electron integration for the backend controls added in phase 2. The
// task planner is deterministic test code; HTTPS is a local self-signed
// fixture accepted only by this task's isolated Electron session.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execFileSync, execFile, spawn } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { AgentViewportHost, applyBrowserHardening, makeDualSurfaceBrowser } = require("../main/harness/agent-viewport-host");
const { TaskHost } = require("../main/harness/task-host");
const { HostSettingsStore } = require("../main/harness/host-settings");
const { LocalMemoryStore } = require("../main/harness/local-memory-store");
const { LocalCredentialVault } = require("../main/harness/local-credential-vault");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { sumProcessTreeRssBytes } = require("../main/harness/process-tree-memory");
const { requestDecision } = require("../main/approver-client");

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..", "..");
const APPROVER_SCRIPT = path.join(APP_ROOT, "approver", "approver_service.py");
const LONG_HORIZON_PLANNER = path.join(APP_ROOT, "fixtures", "scripted-planner-long-horizon.js");

function processTreeRss(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,rss="], (error, stdout) => {
      resolve(error ? null : sumProcessTreeRssBytes(stdout, pid));
    });
  });
}

async function startApprover() {
  // AF_UNIX path limits are small on macOS, so keep this socket directory
  // directly under the short system temp root rather than nested under the
  // longer integration-run directory.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "halo-a-")));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, "approver.sock");
  const child = spawn(process.env.HALO_PYTHON || "python3", [APPROVER_SCRIPT, "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`approver readiness timeout: ${stderr}`)), 10000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes("halo computer-use approver ready")) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`approver exited early (${code}/${signal}): ${stderr}`)); });
    });
  } catch (error) {
    child.kill();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { child, socketPath, directory };
}

async function runParallelAdmission(tempRoot, url) {
  const storageRoot = path.join(tempRoot, "parallel-tasks");
  const approver = await startApprover();
  const window = new BrowserWindow({ show: false, width: 1280, height: 800 });
  const agentViewportHost = new AgentViewportHost();
  const monitor = new MemoryMonitor({ getAppMetrics: () => app.getAppMetrics(), getExternalMemoryBytes: processTreeRss });
  const approverStartedAt = Date.now();
  monitor.registerExternalProcess({ pid: approver.child.pid, creationTime: approverStartedAt, label: "approver" });
  const approvalErrors = [];
  const host = new TaskHost({
    storageRoot,
    executionMode: "parallel",
    memoryMonitor: monitor,
    makeBrowser: (taskId) => {
      const view = new WebContentsView({ webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: `halo-task-${taskId}`,
      } });
      applyBrowserHardening(view.webContents);
      window.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      const visibleAdapter = new BrowserAdapter({ view });
      const agentAdapter = agentViewportHost.ensure(taskId);
      agentViewportHost._hosts.get(taskId).view.webContents.session.setCertificateVerifyProc((_request, callback) => callback(0));
      return makeDualSurfaceBrowser({ agentAdapter, visibleAdapter, disposeAgent: () => agentViewportHost.dispose(taskId) });
    },
    makePlanner: () => new PlannerStdioAdapter({
      command: process.execPath,
      args: [LONG_HORIZON_PLANNER],
      cwd: APP_ROOT,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      onWorkerStart: ({ pid, creationTime }) => monitor.registerExternalProcess({ pid, creationTime, label: "planner" }),
      onWorkerExit: ({ pid, creationTime }) => monitor.unregister(pid, creationTime),
    }),
    hostVerifier: () => true,
    approve: async (_taskId, descriptor) => {
      try {
        return await requestDecision(approver.socketPath, {
          request_id: descriptor.requestId,
          action: descriptor.action,
          origin: descriptor.origin || "",
          summary: descriptor.summary,
          self_provenance: descriptor.selfProvenance,
          source: descriptor.source,
          target_scope: descriptor.targetScope ?? null,
          contains_secret: Boolean(descriptor.containsSecret),
        });
      } catch (error) {
        approvalErrors.push(String(error.message || error));
        throw error;
      }
    },
  });

  try {
    await monitor.sample();
    const first = await host.createTask({ originalRequest: `Visit ${url}` });
    const beforeSecond = await monitor.sample();
    const plannerHighWaterBytes = monitor.getExternalProcessHighWaterBytes("planner");
    if (beforeSecond.unmeasurable.length || !plannerHighWaterBytes) {
      throw new Error(`could not measure planner/browser processes before second admission: ${JSON.stringify(beforeSecond)}`);
    }
    const second = await host.createTask({ originalRequest: `Visit ${url}` });
    if (first.snapshot.state !== "awaiting_approval" || second.snapshot.state !== "awaiting_approval") {
      throw new Error(`real planner/approver flow did not reach human review: first=${first.snapshot.state}, second=${second.snapshot.state}`);
    }
    const [firstDetail, secondDetail] = await Promise.all([
      host.getTaskDetail(first.taskId),
      host.getTaskDetail(second.taskId),
    ]);
    const firstApprovalId = firstDetail.snapshot.approvalQueue[0]?.id;
    const secondApprovalId = secondDetail.snapshot.approvalQueue[0]?.id;
    if (!firstApprovalId || !secondApprovalId) throw new Error("both parallel tasks must hold a live human-review item");
    const approvalResults = await Promise.all([
      host.approveTask(first.taskId, firstApprovalId),
      host.approveTask(second.taskId, secondApprovalId),
    ]);

    const samples = [];
    const deadline = Date.now() + 10000;
    let liveTasks = [];
    while (Date.now() < deadline) {
      samples.push(await monitor.sample());
      liveTasks = await host.listTasks();
      if (liveTasks.filter((item) => item.active).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const allSamples = [beforeSecond, ...samples];
    const latest = allSamples.at(-1);
    const plannerSamples = latest.byProcess.filter((item) => item.label === "external:planner" && Number.isFinite(item.bytes));
    const approverMeasured = latest.byProcess.some((item) => item.label === "external:approver" && Number.isFinite(item.bytes));
    const unmeasurable = [...new Set(allSamples.flatMap((sample) => sample.unmeasurable))];
    const aggregatePeakBytes = Math.max(...allSamples.map((sample) => sample.totalBytes));
    const actionOutcomes = await Promise.all([first.taskId, second.taskId].map((id) => host.getTaskEvents(id)));
    const successfulActions = actionOutcomes.flat().filter((event) => event.type === "action_outcome" && event.payload?.status === "ok");
    const bothHumanApprovalsReleased = approvalResults.every((snapshot) => snapshot.state === "awaiting_verification");
    const result = {
      twoTaskHostAdmission: second.snapshot.state !== "queued" && liveTasks.filter((item) => item.active).length === 2,
      firstTaskState: first.snapshot.state,
      secondTaskState: second.snapshot.state,
      firstPauseReason: first.snapshot.pauseReason,
      secondPauseReason: second.snapshot.pauseReason,
      bothHumanApprovalsReleased,
      realActionsDispatched: successfulActions.length >= 2,
      successfulActionCount: successfulActions.length,
      plannerHighWaterBytes,
      plannerProcessesMeasured: plannerSamples.length,
      approverMeasured,
      sampleCount: allSamples.length,
      unmeasurable,
      aggregatePeakBytes,
      limitBytes: 1_000_000_000,
      workersMeasured: plannerSamples.length === 2 && approverMeasured && unmeasurable.length === 0,
    };
    if (!result.twoTaskHostAdmission || !result.bothHumanApprovalsReleased || !result.realActionsDispatched || !result.workersMeasured || approvalErrors.length > 0 || aggregatePeakBytes >= result.limitBytes) {
      throw new Error(`parallel memory admission failed: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await host.close().catch(() => {});
    await agentViewportHost.disposeAll();
    if (!window.isDestroyed()) window.destroy();
    monitor.unregister(approver.child.pid, approverStartedAt);
    approver.child.kill();
    if (approver.child.exitCode === null && approver.child.signalCode === null) {
      await new Promise((resolve) => approver.child.once("exit", resolve));
    }
    await fs.rm(approver.directory, { recursive: true, force: true });
  }
}

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8").split("").reverse().join(""),
};

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-backend-controls-"));
  const pkiRoot = path.join(tempRoot, "pki");
  await fs.mkdir(pkiRoot, { mode: 0o700 });
  const keyPath = path.join(pkiRoot, "key.pem");
  const certPath = path.join(pkiRoot, "cert.pem");
  execFileSync("/usr/bin/openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  const key = await fs.readFile(keyPath);
  const cert = await fs.readFile(certPath);
  const server = https.createServer({ key, cert }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>HALO local credential fixture</title>
      <main>DONE-XYZ</main>
      <label for="username">Username</label><input id="username" autocomplete="username">
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password">
      <button type="submit">Sign in</button>`);
  });

  let window;
  let host;
  let recoveredHost;
  let exitCode = 0;
  let taskId;
  let queuedTaskId;
  const views = new Map();
  const result = {
    real: true,
    permission: { observeDenied: false, browseNavigated: false },
    credential: { autofillSucceeded: false, noSecretInJournal: false },
    queue: { recoveredFifo: false, noEagerBrowserAttach: false },
    memory: { automaticUntrustedContext: false },
  };

  const makeBrowser = (id) => {
    const view = new WebContentsView({ webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `halo-backend-controls-${id}`,
    } });
    applyBrowserHardening(view.webContents);
    view.webContents.session.setCertificateVerifyProc((_request, callback) => callback(0));
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
    const browser = new BrowserAdapter({ view });
    views.set(id, { view, browser });
    return browser;
  };

  const makeHost = (storageRoot, { makeBrowserFactory = makeBrowser, memoryStore, settingsStore, credentialVault, permissionMode = "browse", plannerEffort = "medium", executionMode = "sequential" } = {}) => new TaskHost({
    storageRoot,
    makeBrowser: makeBrowserFactory,
    makePlanner: () => ({
      next: async (context) => {
        result.memory.automaticUntrustedContext ||= context.userMemory?.authority === "untrusted_user_memory" &&
          context.userMemory.entries.some((entry) => entry.text === "backend integration memory sentinel");
        return {
          taskId: context.taskId,
          goalVersion: context.goalVersion,
          basedOnObservationId: "integration-observation",
          criterionIds: [],
          kind: "finish",
          evidenceIds: [],
        };
      },
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    settingsStore,
    memoryStore,
    credentialVault,
    permissionMode,
    plannerEffort,
    executionMode,
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const storageRoot = path.join(tempRoot, "tasks");
    const dataRoot = path.join(tempRoot, "data");
    const settingsStore = new HostSettingsStore({ storageRoot: dataRoot });
    const memoryStore = new LocalMemoryStore({ storageRoot: dataRoot, safeStorage: cipher });
    const credentialVault = new LocalCredentialVault({ storageRoot: dataRoot, safeStorage: cipher });
    await memoryStore.put({ text: "backend integration memory sentinel" });
    await settingsStore.update({ permissionMode: "observe" });
    host = makeHost(storageRoot, { memoryStore, settingsStore, credentialVault, permissionMode: "observe" });

    const started = await host.createTask({ originalRequest: "Exercise local browser backend controls" });
    taskId = started.taskId;
    const activeBrowser = views.get(taskId).browser;
    const secureUrl = `https://localhost:${server.address().port}/login`;
    const denied = await activeBrowser.execute({ type: "navigate", url: secureUrl });
    result.permission.observeDenied = denied.status === "failed" && denied.errorCode === "permission_mode_denied";
    assert.equal(result.permission.observeDenied, true, JSON.stringify(denied));

    await host.updateHostSettings({ permissionMode: "browse" });
    const navigated = await activeBrowser.execute({ type: "navigate", url: secureUrl });
    const activePage = activeBrowser.getBrowserSnapshot().tabs?.find((tab) => tab.id === activeBrowser.getBrowserSnapshot().activeTabId);
    result.permission.browseNavigated = navigated.status === "ok" && activePage?.url.startsWith("https://localhost:");
    assert.equal(result.permission.browseNavigated, true, JSON.stringify(navigated));

    const saved = await host.saveCredential({ origin: secureUrl, username: "halo-user", password: "integration-secret" });
    const filled = await host.fillCredential(taskId, saved.id);
    const pageValues = await views.get(taskId).view.webContents.executeJavaScript(`({ username: document.querySelector('#username').value, password: document.querySelector('#password').value })`);
    result.credential.autofillSucceeded = filled.status === "ok" && pageValues.username === "halo-user" && pageValues.password === "integration-secret";
    const events = await host.getTaskEvents(taskId);
    const serializedEvents = JSON.stringify(events);
    result.credential.noSecretInJournal = !serializedEvents.includes("integration-secret") && !serializedEvents.includes("halo-user") && serializedEvents.includes(saved.id);
    assert.equal(result.credential.autofillSucceeded, true);
    assert.equal(result.credential.noSecretInJournal, true);
    assert.equal(result.memory.automaticUntrustedContext, true);

    const queued = await host.createTask({ originalRequest: "Must remain behind the current task" });
    queuedTaskId = queued.taskId;
    assert.equal(queued.snapshot.state, "queued");
    await host.close();
    host = null;
    views.clear();

    let eagerBrowserCount = 0;
    recoveredHost = makeHost(storageRoot, {
      makeBrowserFactory: () => { eagerBrowserCount += 1; throw new Error("restart listing must not create a browser"); },
      memoryStore,
      settingsStore,
      credentialVault,
    });
    const recovered = await recoveredHost.listTasks();
    const recoveredOrder = recovered.filter((item) => item.taskId === taskId || item.taskId === queuedTaskId)
      .sort((left, right) => left.queuePosition - right.queuePosition)
      .map((item) => item.taskId);
    result.queue.recoveredFifo = recoveredOrder[0] === taskId && recoveredOrder[1] === queuedTaskId;
    result.queue.noEagerBrowserAttach = eagerBrowserCount === 0 && recovered.every((item) => item.active === false);
    assert.equal(result.queue.recoveredFifo, true, JSON.stringify(recovered));
    assert.equal(result.queue.noEagerBrowserAttach, true);

    result.parallel = await runParallelAdmission(tempRoot, secureUrl);

    process.stdout.write(`RESULT_JSON:${JSON.stringify({ ...result, pass: true })}\n`);
  } catch (error) {
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ ...result, error: String(error.stack || error) })}\n`);
    exitCode = 1;
  } finally {
    await Promise.allSettled([host?.close(), recoveredHost?.close()]);
    if (window && !window.isDestroyed()) window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
    app.exit(exitCode);
  }
}

main().catch((error) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, error: String(error.stack || error) })}\n`);
  app.exit(1);
});
