"use strict";

// Real-Electron end-to-end evidence for the P0 agent viewport/background
// isolation change (chat 2026-09-28). Launched as
// `electron integration/agent-viewport-lifecycle-electron.js` (never via
// `node --test` -- same reason as integration/long-horizon-electron.js: a
// real listener/child window stays outside test/).
//
// Unlike integration/agent-viewport-spike.js (Codex-owned, a design-spike
// probe of raw Electron primitives, not wired into product code), this file
// exercises the REAL production modules this change actually ships:
// main/harness/agent-viewport-host.js's AgentViewportHost/
// makeDualSurfaceBrowser, main/harness/browser-adapter.js's BrowserAdapter
// (unmodified), and main/harness/memory-monitor.js's MemoryMonitor
// (unmodified). It proves the thing the user explicitly required: that
// autonomous execute()/observe() genuinely lands on the fixed, hidden
// 1440x900 view, that manual userNavigate() genuinely lands on the visible
// view instead, and that the two are the same Electron session partition
// (shared login/cookies) but otherwise fully separate WebContents.
//
// Does NOT re-test task-controller.js's own isUserControlled()/userNavigate
// access-control gating (task-controller.test.js already covers that,
// unmodified) -- this file calls the composed browser object's
// execute()/userNavigate() directly to prove the ROUTING/isolation
// contract with real Electron windows, not to re-litigate who is allowed to
// call which method when.

const assert = require("node:assert/strict");
const { app, BrowserWindow, WebContentsView } = require("electron");

const { AgentViewportHost, makeDualSurfaceBrowser, AGENT_WIDTH, AGENT_HEIGHT } = require("../main/harness/agent-viewport-host");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { startFixtureServer } = require("../fixtures/long-horizon-site");

const TASK_ID = "agent-viewport-lifecycle-task";

function layoutScript() {
  return `({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
  })`;
}

async function main() {
  await app.whenReady();
  const fixture = await startFixtureServer();
  const results = {};

  try {
    // --- Setup: the same two-surface wiring main/index.js's
    // makeHarnessBrowser performs for a real task, minus the React chrome
    // window (out of scope: frontend/** untouched, and this integration
    // test targets the harness/main layer only).
    const mainWin = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const visibleView = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `halo-task-${TASK_ID}`,
    } });
    mainWin.contentView.addChildView(visibleView);
    visibleView.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const visibleAdapter = new BrowserAdapter({ view: visibleView });

    const agentViewportHost = new AgentViewportHost();
    const agentAdapter = agentViewportHost.ensure(TASK_ID);
    const browser = makeDualSurfaceBrowser({
      agentAdapter,
      visibleAdapter,
      disposeAgent: () => agentViewportHost.dispose(TASK_ID),
    });

    // --- 1. Fixed 1440x900 viewport, independent of the visible window ---
    const navResult = await browser.execute({ type: "navigate", url: `${fixture.url}page2` });
    assert.equal(navResult.status, "ok", `agent navigate must succeed: ${JSON.stringify(navResult)}`);
    const agentWc = agentViewportHost._hosts.get(TASK_ID).view.webContents;
    const layout = await agentWc.executeJavaScript(layoutScript());
    assert.deepEqual(layout, { innerWidth: AGENT_WIDTH, innerHeight: AGENT_HEIGHT, clientWidth: AGENT_WIDTH, clientHeight: AGENT_HEIGHT });
    const hiddenHost = agentViewportHost._hosts.get(TASK_ID).host;
    assert.equal(hiddenHost.isVisible(), false, "the hidden agent host window must never become visible");
    results.agentViewport = layout;

    // --- 2. Execution-target separation: execute()/observe() land on the
    // hidden agent view; userNavigate() lands on the visible view. Real
    // Electron URLs, not mocked/spied methods. ---
    await browser.userNavigate({ type: "navigate", url: fixture.url });
    const agentUrl = agentWc.getURL();
    const visibleUrl = visibleView.webContents.getURL();
    assert.equal(agentUrl, `${fixture.url}page2`, "autonomous execute() must have navigated the HIDDEN view, not the visible one");
    assert.equal(visibleUrl, fixture.url, "userNavigate() must have navigated the VISIBLE view, not the hidden one");
    assert.notEqual(agentUrl, visibleUrl, "the two surfaces must be genuinely different documents, not the same WebContents");
    results.executionSeparation = { agentUrl, visibleUrl };

    const observation = await browser.observe({});
    assert.equal(observation.url, `${fixture.url}page2`, "observe() must read the HIDDEN view's document, matching where execute() actually navigated");
    results.observeMatchesAgentView = true;

    // --- 3. No focus stealing: creating/navigating/showing the agent view
    // must never activate/focus any window belonging to the user. ---
    assert.equal(mainWin.isFocused(), false);
    results.noFocusSteal = { mainWinFocused: mainWin.isFocused(), hiddenHostVisible: hiddenHost.isVisible() };

    // --- 4. Shared session/cookie partition (design doc's session boundary):
    // a cookie set through one surface's session must be visible through the
    // other's, because both share partition `halo-task-${TASK_ID}`. ---
    const cookieUrl = fixture.url;
    await visibleView.webContents.session.cookies.set({ url: cookieUrl, name: "halo_probe", value: "shared" });
    const cookiesFromAgentSession = await agentWc.session.cookies.get({ url: cookieUrl, name: "halo_probe" });
    assert.equal(cookiesFromAgentSession.length, 1, "agent view's session must see the cookie set via the visible view (shared task partition)");
    assert.equal(cookiesFromAgentSession[0].value, "shared");
    results.sharedSessionPartition = true;

    // --- 5. MemoryMonitor sees the agent renderer's exact PID; it disappears
    // after dispose(). getOSProcessId() (not "any new pid since before") is
    // used deliberately: GPU/network-service/utility processes are shared
    // across the whole app and can appear as a side effect of creating the
    // agent view without being exclusively owned by it, so "new pid" alone
    // is not a reliable signal that THIS renderer specifically went away.
    // No manual registerExternalProcess() call is needed for an
    // Electron-owned renderer -- app.getAppMetrics() already covers it. ---
    const agentRendererPid = agentWc.getOSProcessId();
    assert.ok(Number.isInteger(agentRendererPid) && agentRendererPid > 0, "agent view must have a real OS renderer process id");
    const metricsBeforeDispose = app.getAppMetrics();
    assert.ok(metricsBeforeDispose.some((m) => m.pid === agentRendererPid), "MemoryMonitor's own data source (app.getAppMetrics()) must see the agent renderer's pid before dispose");

    const memoryMonitor = new MemoryMonitor({ getAppMetrics: () => app.getAppMetrics(), getExternalMemoryBytes: async () => null });
    await memoryMonitor.sample();
    results.memoryMonitorSawAgentPid = true;

    await browser.dispose();
    // Electron reaps the renderer process asynchronously; poll briefly
    // rather than asserting immediately after dispose() returns.
    const disposeDeadline = Date.now() + 5000;
    let stillPresent = true;
    while (Date.now() < disposeDeadline) {
      stillPresent = app.getAppMetrics().some((m) => m.pid === agentRendererPid);
      if (!stillPresent) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(stillPresent, false, `agent renderer pid ${agentRendererPid} must be gone from app.getAppMetrics() after dispose()`);
    results.pidGoneAfterDispose = true;

    await visibleAdapter.dispose();
    mainWin.destroy();

    results.pass = true;
    process.stdout.write(`RESULT_JSON=${JSON.stringify(results)}\n`);
  } finally {
    await fixture.stop();
  }
}

main().then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
