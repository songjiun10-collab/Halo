"use strict";

// Run with `npm run test:renderer:e2e` from apps/computer-browser. This is a
// real, hidden Electron window with the production bundle, preload, IPC,
// TaskHost, BrowserAdapter and native BrowserSurfaces. The planner is the
// existing deterministic JSONL fixture, not a language model. Decisions
// cross the real Python approver's Unix socket. Every user mutation below
// enters through the React DOM; direct host calls are read-only assertions.
// Kept outside test/ so node --test does not launch a second Electron app
// alongside the separate aggregate-memory integration measurement.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { ControlApi } = require("../main/control-api");
const registerIpc = require("../main/ipc");
const { requestDecision } = require("../main/approver-client");
const { TaskHost } = require("../main/harness/task-host");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { BrowserSurfaces } = require("../main/harness/browser-surfaces");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { startFixtureServer } = require("../fixtures/long-horizon-site");
const layout = require("../shared/layout-constants");

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const RENDERER = path.join(APP_ROOT, "renderer", "dist", "index.html");
const PLANNER = path.join(APP_ROOT, "fixtures", "scripted-planner-long-horizon.js");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, probe, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(35);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function spawnApprover(socketPath) {
  const python = process.env.HALO_PYTHON || path.join(REPO_ROOT, ".venv", "bin", "python");
  const child = spawn(python, [path.join(APP_ROOT, "approver", "approver_service.py"), "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Python approver startup timeout: ${stderr}`)), 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Python approver exited before ready: code=${code} signal=${signal}; ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("halo computer-use approver ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { child, ready, getStderr: () => stderr };
}

function driver(win) {
  const evaluate = (source) => win.webContents.executeJavaScript(source, true);
  const ready = (selector) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.closest('[inert]') || el.disabled) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`);
  return {
    evaluate,
    ready,
    text: (selector = "body") => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`),
    async click(selector) {
      await waitFor(`usable DOM control ${selector}`, () => ready(selector));
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.closest('[inert]') || el.disabled) throw new Error('Control became unavailable');
        el.click();
      })()`);
    },
    async clickText(scope, text) {
      const find = `Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(el => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled && !el.closest('[inert]'))`;
      await waitFor(`button ${text}`, () => evaluate(`Boolean(${find})`));
      await evaluate(`(${find}).click()`);
    },
    async submit(selector, value) {
      await waitFor(`composer ${selector}`, () => ready(selector));
      // Use the native setter so React receives a real input change and
      // runs its own controlled-input and submit handlers.
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor("enabled composer submit", () => evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return Boolean(el?.form?.querySelector('button[type="submit"]:not(:disabled)'));
      })()`));
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
    },
  };
}

async function installRendererDiagnostics(win, report) {
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === 3) {
      report.consoleErrors.push({ message: event.message, source: event.sourceId, line: event.lineNumber });
    }
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    report.consoleErrors.push({ message: `Preload failed: ${error.message}`, source: preloadPath });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    report.consoleErrors.push({ message: `Renderer exited: ${JSON.stringify(details)}` });
  });
  // Install before navigation, including on reload, so CSP violations at
  // bundle/font startup cannot disappear before a post-load listener.
  process.stdout.write("[phase2] debugger attach\n");
  win.webContents.debugger.attach("1.3");
  process.stdout.write("[phase2] debugger Page.enable\n");
  await win.webContents.debugger.sendCommand("Page.enable");
  process.stdout.write("[phase2] debugger install startup probe\n");
  await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__phase2Diagnostics = { cspViolations: [], exceptions: [], taskPushes: [] };
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__phase2Diagnostics.cspViolations.push({
          directive: event.violatedDirective, blockedURI: event.blockedURI, source: event.sourceFile
        });
      });
      window.addEventListener('error', (event) => window.__phase2Diagnostics.exceptions.push(event.message));
      window.addEventListener('unhandledrejection', (event) => window.__phase2Diagnostics.exceptions.push(String(event.reason)));
      window.addEventListener('DOMContentLoaded', () => {
        window.haloBrowser?.onTaskEvent((event) => window.__phase2Diagnostics.taskPushes.push({
          taskId: event.taskId, state: event.snapshot.state, goalVersion: event.snapshot.goalVersion
        }));
      }, { once: true });
    `,
  });
  process.stdout.write("[phase2] debugger ready\n");
}

async function main() {
  const startedAt = Date.now();
  process.on("exit", (code) => process.stdout.write(`[phase2] process exit ${code}\n`));
  process.on("uncaughtExceptionMonitor", (error) => process.stderr.write(`[phase2] uncaught exception: ${error.stack || error}\n`));
  process.on("unhandledRejection", (error) => process.stderr.write(`[phase2] unhandled rejection: ${error?.stack || error}\n`));
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-phase2-renderer-"));
  const storageRoot = process.env.HALO_TEST_STORAGE_ROOT || path.join(runRoot, "tasks");
  app.setPath("userData", path.join(runRoot, "electron-profile"));
  await fs.access(RENDERER).catch(() => { throw new Error("Renderer bundle missing; run npm run build first"); });
  await app.whenReady();
  // Keep cleanup/reporting alive after the hidden test window closes. Without
  // this, macOS may terminate Electron before RESULT_JSON is flushed.
  app.on("window-all-closed", () => {});

  const report = {
    real: true,
    pass: false,
    stage: "setup",
    runRoot,
    storageRoot,
    planner: "deterministic JSONL fixture; no model-quality claim",
    consoleErrors: [],
    cspViolations: [],
    exceptions: [],
    taskPushes: [],
    decisions: [],
    screenshots: [],
  };
  let win;
  let taskHost;
  let fixture;
  let approver;
  let ui;
  const views = new Map();
  const mark = (stage) => {
    report.stage = stage;
    process.stdout.write(`[phase2] ${stage}\n`);
  };
  const health = async () => {
    const diagnostics = await ui.evaluate("window.__phase2Diagnostics");
    report.cspViolations.push(...diagnostics.cspViolations);
    report.exceptions.push(...diagnostics.exceptions);
    report.taskPushes.push(...diagnostics.taskPushes);
    await ui.evaluate("window.__phase2Diagnostics = { cspViolations: [], exceptions: [], taskPushes: [] }");
  };

  try {
    mark("fixture startup");
    fixture = await startFixtureServer();
    const socketDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "halo-phase2-approver-")));
    await fs.chmod(socketDir, 0o700);
    const socketPath = path.join(socketDir, "approver.sock");
    approver = spawnApprover(socketPath);
    mark("approver startup");
    await approver.ready;

    mark("Electron readiness");
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        preload: path.join(APP_ROOT, "preload", "index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: [`--halo-layout=${JSON.stringify({
          headerHeight: layout.HEADER_HEIGHT,
          footerHeight: layout.FOOTER_HEIGHT,
          sidePanelWidth: layout.SIDE_PANEL_WIDTH,
          mobileBreakpoint: layout.MOBILE_BREAKPOINT,
        })}`],
      },
    });
    win.once("closed", () => process.stdout.write("[phase2] test window closed\n"));
    mark("window created");
    const surfaces = new BrowserSurfaces(win, { isUserControlled: (taskId) => taskHost.canUseTaskBrowser(taskId) });
    taskHost = new TaskHost({
      storageRoot,
      makeBrowser: (taskId) => {
        const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        surfaces.register(taskId, view);
        views.set(taskId, view);
        return new BrowserAdapter({ view });
      },
      setViewport: (taskId, bounds) => surfaces.setViewport(taskId, bounds),
      makePlanner: () => new PlannerStdioAdapter({
        command: process.env.HALO_NODE_COMMAND || process.execPath,
        args: [PLANNER],
        cwd: APP_ROOT,
        env: process.env.HALO_NODE_COMMAND ? {} : { ELECTRON_RUN_AS_NODE: "1" },
      }),
      hostVerifier: (_criterion, evidence) => evidence.kind === "host_check" ? true : undefined,
      approve: async (taskId, descriptor) => {
        const decision = await requestDecision(socketPath, {
          request_id: descriptor.requestId,
          action: descriptor.action,
          origin: descriptor.origin || "",
          summary: descriptor.summary,
          self_provenance: descriptor.selfProvenance,
          source: descriptor.source,
          target_scope: descriptor.targetScope ?? null,
          contains_secret: Boolean(descriptor.containsSecret),
        });
        report.decisions.push({ taskId, requestId: descriptor.requestId, action: descriptor.action, decision: decision.decision });
        return decision;
      },
    });
    registerIpc(win, new ControlApi({ window: win, socketPath }), { taskHost });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    ui = driver(win);
    mark("renderer file load");
    await win.loadFile(RENDERER);
    mark("renderer diagnostics setup");
    await installRendererDiagnostics(win, report);
    const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
    win.webContents.reload();
    await reloaded;
    mark("renderer readiness");
    await waitFor("React renderer and real preload", () => ui.evaluate("Boolean(document.querySelector('.hx-app') && window.haloBrowser?.onTaskEvent && window.haloBrowser?.getTaskEvents)"));
    assert.deepEqual(await taskHost.listTasks(), [], "test storage must start empty");
    const csp = await ui.evaluate("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content || ''");
    assert.match(csp, /script-src\s+'self'(?:;|\s)/);
    assert.match(csp, /connect-src\s+'none'(?:;|\s)/);
    assert.ok(!/script-src[^;]*'unsafe-(?:inline|eval)'/.test(csp), "script CSP must remain strict");
    report.csp = csp;

    mark("DOM task creation and approval boundary");
    const goal = `  Phase 2  방문 확인: ${fixture.url}  `;
    await ui.submit('[aria-label="What should the agent do?"]', goal);
    const firstTask = await waitFor("created task awaiting approval", async () => {
      const list = await taskHost.listTasks();
      return list.length === 1 && list[0].state === "awaiting_approval" ? list[0] : false;
    });
    const firstId = firstTask.taskId;
    assert.equal((await taskHost.getTaskDetail(firstId)).goal.originalRequest, goal, "composer must preserve original request verbatim");
    assert.deepEqual(fixture.requestLog, [], "no fixture navigation may happen before UI approval");
    await waitFor("approval sheet", () => ui.ready('.hx-sheet button'));
    assert.ok([...views.values()].every((view) => !view.getVisible()), "approval modal must hide every native browser surface");
    const approvalPng = path.join(runRoot, "approval.png");
    await fs.writeFile(approvalPng, (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(approvalPng);

    let approvalCount = 0;
    for (; approvalCount < 3; approvalCount += 1) {
      const before = await taskHost.getTaskDetail(firstId);
      assert.equal(before.snapshot.state, "awaiting_approval");
      const requestId = before.snapshot.approvalQueue[0].id;
      await waitFor("current approval in DOM", () => ui.evaluate(`Boolean(document.querySelector('.hx-sheet[data-approval-id=${JSON.stringify(requestId)}]'))`));
      await ui.clickText(".hx-sheet", "Allow once");
      await waitFor("approved action outcome and next controller state", async () => {
        const detail = await taskHost.getTaskDetail(firstId);
        return detail.snapshot.state === "awaiting_verification" ||
          (detail.snapshot.state === "awaiting_approval" && detail.snapshot.approvalQueue[0]?.id !== requestId);
      });
    }
    const awaiting = await taskHost.getTaskDetail(firstId);
    assert.equal(awaiting.snapshot.state, "awaiting_verification");
    assert.equal(awaiting.snapshot.criteriaStatus.find((criterion) => criterion.criterionId === "C1").status, "pending");
    assert.deepEqual(fixture.requestLog.map((request) => request.path), ["/", "/page2", "/page3"]);
    await waitFor("selected browser surface restored after approval closes", () => views.get(firstId)?.getVisible() === true);
    assert.ok([...views.entries()].every(([taskId, view]) => taskId === firstId ? view.getVisible() : !view.getVisible()),
      "closing the approval sheet must reveal only the selected task's native browser surface");

    mark("DOM criterion confirmation and durable timeline");
    await ui.click('.hx-halo');
    await waitFor("criterion confirmation", () => ui.ready('[aria-label="Confirm criterion C1"]'));
    assert.ok([...views.values()].every((view) => !view.getVisible()), "chat must hide native browser content");
    await ui.click('[aria-label="Confirm criterion C1"]');
    await waitFor("completed after trusted user confirmation", async () => (await taskHost.getTaskDetail(firstId)).snapshot.state === "completed");
    const firstEvents = await taskHost.getTaskEvents(firstId);
    assert.ok(firstEvents.some((event) => event.type === "evidence_recorded" && event.payload.evidence.kind === "user_confirmation"));
    const chatPng = path.join(runRoot, "completed-chat.png");
    await fs.writeFile(chatPng, (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(chatPng);
    await ui.click('[aria-label="View task activity"]');
    await waitFor("timeline panel", () => ui.ready('#hx-activity'));
    await ui.click('.hx-activity__toggle');
    await waitFor("journal event rows", () => ui.evaluate(`document.querySelectorAll('.hx-steps li').length === ${firstEvents.length}`));
    report.approvalFlow = { taskId: firstId, approvalCount, finalState: "completed", journalEvents: firstEvents.length };
    await ui.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor("activity panel closed", () => ui.evaluate("!document.querySelector('#hx-activity')"));

    mark("DOM denial never dispatches and takeover returns control");
    await ui.click('.hx-halo');
    await ui.click('[aria-label="New task"]');
    const deniedGoal = `  Deny journey  ${fixture.url}  `;
    await ui.submit('[aria-label="What should the agent do?"]', deniedGoal);
    const secondTask = await waitFor("second task awaiting approval", async () => {
      const list = await taskHost.listTasks();
      return list.find((entry) => entry.taskId !== firstId && entry.state === "awaiting_approval");
    });
    const secondId = secondTask.taskId;
    const deniedId = (await taskHost.getTaskDetail(secondId)).snapshot.approvalQueue[0].id;
    await waitFor("second task approval in DOM", () => ui.evaluate(`Boolean(document.querySelector('.hx-sheet[data-approval-id=${JSON.stringify(deniedId)}]'))`));
    const requestCountBeforeDenial = fixture.requestLog.length;
    await ui.clickText('.hx-sheet', 'Deny');
    await waitFor("denied request removed", async () => {
      const detail = await taskHost.getTaskDetail(secondId);
      return detail.snapshot.state === "awaiting_approval" && detail.snapshot.approvalQueue[0]?.id !== deniedId;
    });
    assert.equal(fixture.requestLog.length, requestCountBeforeDenial, "denial must not dispatch navigation");
    assert.ok(!(await taskHost.getTaskEvents(secondId)).some((event) => event.type === "action_started"), "denied task must have no action_started journal record");
    await ui.clickText('.hx-sheet', 'Take over');
    await waitFor("takeover state", async () => (await taskHost.getTaskDetail(secondId)).snapshot.pauseReason === "user_takeover");
    report.denialFlow = { taskId: secondId, deniedRequestId: deniedId, dispatchedActions: 0, finalState: "paused" };

    mark("DOM exact goal amendment and task scope switch");
    await ui.click('.hx-halo');
    mark("goal amendment chat open");
    const amendment = "  Keep the original goal.  목표 수정: 확인만 하고 멈춰 주세요.  ";
    await ui.submit('[aria-label="Amend task goal"]', amendment);
    mark("goal amendment submitted");
    await waitFor("amendment persisted", async () => (await taskHost.getTaskDetail(secondId)).goal.goalVersion === 2);
    mark("goal amendment persisted");
    const amended = await taskHost.getTaskDetail(secondId);
    assert.equal(amended.goal.originalRequest, deniedGoal, "amendment must not rewrite originalRequest");
    assert.equal(amended.goal.amendments.at(-1).text, amendment, "amendment text must remain verbatim");
    assert.equal(amended.goal.amendments.at(-1).authority, "user");
    await waitFor("amendment visible in chat", async () => (await ui.text('#hx-chat')).includes(amendment));
    mark("goal amendment rendered");
    await ui.click(`[data-task-id="${firstId}"]`);
    mark("first task selected");
    await waitFor("first task chat selected", () => ui.evaluate(`document.querySelector('.hx-app')?.dataset.activeTaskId === ${JSON.stringify(firstId)}`));
    assert.ok(!(await ui.text('#hx-chat')).includes(amendment), "second task amendment must not appear in first task chat");
    assert.equal((await taskHost.getTaskDetail(firstId)).goal.goalVersion, 1);
    await ui.click('[aria-label="Close chat"]');
    mark("first task chat closed");
    await waitFor("selected native task surface", () => views.get(firstId).getVisible());
    assert.equal(views.get(firstId).webContents.getURL(), `${fixture.url}page3`);
    assert.equal(views.get(secondId).getVisible(), false, "nonselected native task surface must remain hidden");
    await ui.click('.hx-halo');
    await ui.click(`[data-task-id="${secondId}"]`);
    await waitFor("second task selected", () => ui.evaluate(`document.querySelector('.hx-app')?.dataset.activeTaskId === ${JSON.stringify(secondId)}`));
    await waitFor("second task exact amendment restored", async () => (await ui.text('#hx-chat')).includes(amendment));
    report.amendmentFlow = { taskId: secondId, goalVersion: amended.goal.goalVersion, originalRequestPreserved: true, amendmentVerbatim: true, taskSwitchScoped: true };

    mark("renderer reload and diagnostics");
    await health();
    await win.loadFile(RENDERER);
    await waitFor("reloaded React renderer", () => ui.evaluate("Boolean(document.querySelector('.hx-app') && window.haloBrowser?.onTaskEvent)"));
    await ui.evaluate("document.querySelector('.hx-halo')?.focus()");
    await ui.click('.hx-halo');
    await waitFor("saved task list after renderer reload", () => ui.ready(`[data-task-id="${firstId}"]`));
    await ui.click(`[data-task-id="${firstId}"]`);
    await waitFor("completed task reselected after renderer reload", () => ui.evaluate(`document.querySelector('.hx-app')?.dataset.activeTaskId === ${JSON.stringify(firstId)}`));
    assert.equal((await taskHost.getTaskDetail(firstId)).snapshot.state, "completed");
    assert.equal(fixture.requestLog.length, requestCountBeforeDenial, "UI task switching and reload must not replay completed navigation");
    const beforeHumanNavigation = fixture.requestLog.length;
    await ui.submit('[aria-label="Address"]', fixture.url);
    await waitFor("address bar navigation on the selected native page", () => views.get(firstId).webContents.getURL() === fixture.url);
    assert.equal(fixture.requestLog.length, beforeHumanNavigation + 1, "address entry must navigate the real task browser exactly once");
    await health();
    assert.equal(report.consoleErrors.length, 0, `renderer console errors: ${JSON.stringify(report.consoleErrors)}`);
    assert.deepEqual(report.cspViolations, [], "production renderer must not violate CSP");
    assert.deepEqual(report.exceptions, [], "production renderer must not throw");
    assert.ok(report.taskPushes.some((event) => event.taskId === firstId && event.state === "completed"), "real preload must receive task completion push");
    assert.ok(report.taskPushes.some((event) => event.taskId === secondId && event.goalVersion === 2), "real preload must receive amendment push");
    assert.ok(report.decisions.length >= 5 && report.decisions.every((decision) => decision.decision === "review"), "real Python approver must gate all fixture navigation");
    report.requestPaths = fixture.requestLog.map((request) => request.path);
    report.rendererReload = { savedTasksVisible: true, noNavigationReplay: true };
    report.humanAddressNavigation = { realNativeSurface: true, requestPath: fixture.requestLog.at(-1).path };
    report.pass = true;
    mark("passed");
  } catch (error) {
    report.error = String(error?.stack || error);
    if (ui && win && !win.isDestroyed()) {
      await health().catch(() => {});
      report.dom = (await ui.text().catch(() => "")).slice(0, 14000);
      report.tasks = await taskHost?.listTasks().catch(() => []);
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    const cleanup = await Promise.allSettled([
      taskHost?.close(),
      fixture?.stop(),
    ]);
    const cleanupErrors = cleanup.filter((result) => result.status === "rejected").map((result) => String(result.reason));
    if (approver?.child && approver.child.exitCode === null && !approver.child.killed) approver.child.kill();
    if (cleanupErrors.length) { report.pass = false; report.cleanupErrors = cleanupErrors; }
    report.wallMs = Date.now() - startedAt;
    process.stdout.write(`RESULT_JSON:${JSON.stringify(report)}\n`);
    app.exit(report.pass ? 0 : 1);
  }
}

main().catch((error) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, pass: false, error: String(error?.stack || error) })}\n`);
  app.exit(1);
});
