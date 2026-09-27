"use strict";

const { app, BrowserWindow, WebContentsView } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { ControlApi } = require("./control-api");
const registerIpc = require("./ipc");
const layoutConstants = require("../shared/layout-constants");
const { requestDecision } = require("./approver-client");
const { TaskHost } = require("./harness/task-host");
const { BrowserAdapter } = require("./harness/browser-adapter");
const { BrowserSurfaces } = require("./harness/browser-surfaces");
const { PlannerStdioAdapter } = require("./harness/planner-stdio");
const { MemoryMonitor } = require("./harness/memory-monitor");
const { resolvePlannerCommand } = require("./harness/planner-command");

// Real OS-level RSS lookup for a process Electron itself doesn't track (the
// Python approver, a local planner worker) -- app.getAppMetrics() only ever
// reports Electron's own child processes. `ps -o rss=` reports KB on both
// macOS and Linux; converted to bytes for MemoryMonitor's sample(). Returns
// null (never 0) if the process has already exited or ps itself fails, so a
// process that can't be measured is reported as unmeasurable, not as using
// no memory (see main/harness/memory-monitor.js's own doc comment on this).
function getExternalMemoryBytesViaPs(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const kb = Number(stdout.trim());
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

// The single source of truth for these values. The main process is not
// sandboxed, so it can require the shared module directly; preload cannot
// (see preload/index.js) and receives this same object serialized through
// additionalArguments instead -- one source, two consumers, no drift.
const RENDERER_LAYOUT = Object.freeze({
  headerHeight: layoutConstants.HEADER_HEIGHT,
  footerHeight: layoutConstants.FOOTER_HEIGHT,
  sidePanelWidth: layoutConstants.SIDE_PANEL_WIDTH,
  mobileBreakpoint: layoutConstants.MOBILE_BREAKPOINT,
});

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APPROVER_SCRIPT = path.join(REPO_ROOT, "apps", "computer-browser", "approver", "approver_service.py");

let approverProcess = null;
let socketDir = null;
let memoryPollTimer = null;
const taskHosts = new Set();
const closingTaskHosts = [];
let shutdownStarted = false;

// Single MemoryMonitor for the whole app (design doc section 10, user
// mandate: sum every process HALO's computer-browser actually launches --
// Electron main/renderer/GPU/utility plus the Python approver and any local
// planner worker -- and never satisfy the <1GB budget by measuring V8 heap
// alone or excluding worker processes). Polled on an interval below rather
// than sampled fresh on every getPressureLevel() call, so a per-dispatch
// check in task-controller.js's hot loop never itself does a synchronous OS
// query.
const memoryMonitor = new MemoryMonitor({
  getAppMetrics: () => app.getAppMetrics(),
  getExternalMemoryBytes: getExternalMemoryBytesViaPs,
});

function makeSocketDir() {
  // 0700, owned by this process's uid -- the same contract
  // experiments/e007_dual_agent_provenance_gate/channel.py's
  // UnixSocketChannel enforces on the Python side. realpathSync is required
  // here: macOS's os.tmpdir() resolves under /var, which is itself a symlink
  // to /private/var, and UnixSocketChannel walks every path component from
  // root rejecting any symlink -- an unresolved path makes the approver's
  // listen() fail (silently retried in its loop) forever, and the socket
  // file never gets created. Confirmed by actually running the app: the
  // executor saw a permanent ENOENT until this fix.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "halo-browser-approver-")));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function spawnApprover(socketPath) {
  const python = process.env.HALO_PYTHON || "python3";
  const child = spawn(python, [APPROVER_SCRIPT, "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[approver] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[approver] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.error(`[approver] exited unexpectedly (code=${code}, signal=${signal})`);
    memoryMonitor.unregister(child.pid);
  });
  // Node's child_process doesn't expose the OS's own process-creation
  // timestamp; Date.now() at spawn time is used as the creationTime half of
  // MemoryMonitor's (pid, creationTime) dedup key instead. This is an
  // approximation (not the kernel's actual start time), disclosed here
  // rather than silently treated as exact -- it is precise enough to tell
  // this specific spawn apart from a later, different process that happens
  // to reuse the same pid, which is the only thing the dedup key needs.
  memoryMonitor.registerExternalProcess({ pid: child.pid, creationTime: Date.now(), label: "approver" });
  return child;
}

// Default hostVerifier for "host"-kind criteria (progress.js's
// verifyCriterion): the ONLY thing this accepts outright is "host_check"
// evidence, which browser-adapter.js only ever produces when a real
// navigate()/follow_link() genuinely succeeded -- that fact IS the host's
// own direct confirmation, not a model self-report. "artifact" evidence
// (a bounded page observation) is left "pending" (returning anything other
// than true/false) rather than auto-verified or auto-rejected: this app has
// no real content-matching logic yet to decide whether an arbitrary
// criterion's text is actually satisfied by a page's content, and claiming
// that capability here would be dishonest. A "user"-verification criterion
// never reaches this callback at all (progress.js handles that kind itself).
function defaultHostVerifier(criterion, evidence) {
  if (evidence.kind === "host_check") return true;
  return undefined;
}

// Builds the real approve() TaskController dependency: routes a harness
// task's gated-action descriptor through the same approver-client.js/
// approver_service.py boundary control-api.js's legacy path uses, so both
// paths are judged by the identical independent ALLOW/REVIEW/DENY decision.
function makeHarnessApprove(socketPath) {
  return (taskId, descriptor) =>
    requestDecision(socketPath, {
      request_id: descriptor.requestId,
      action: descriptor.action,
      origin: descriptor.origin || "",
      summary: descriptor.summary,
      self_provenance: descriptor.selfProvenance,
      source: descriptor.source,
      target_scope: descriptor.targetScope ?? null,
      contains_secret: Boolean(descriptor.containsSecret),
    });
}

// Each harness task owns a page. The selected task's native view is laid out
// beneath the React chrome; BrowserSurfaces hides it for renderer overlays.
function makeHarnessBrowser(surfaces) {
  return (taskId) => {
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `halo-task-${taskId}`,
    } });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.webContents.session.on("will-download", (event) => event.preventDefault());
    surfaces.register(taskId, view);
    return new BrowserAdapter({ view });
  };
}

// Planner worker command comes ONLY from trusted host config (env vars set
// by whoever launches this Electron app, or a real `node` binary this host
// discovers on its own PATH -- see harness/planner-command.js) -- never from
// the UI, a page, or the model itself (design doc section 6). With nothing
// configured and no real node found, the adapter stays honestly
// "unavailable" (PlannerStdioAdapter throws
// PlannerTransportError("planner_unavailable", ...) from next()) rather
// than fabricating a natural-language-sounding proposal; task-controller.js
// surfaces that as paused:planner_unavailable.
//
// Resolved ONCE here, not inside the returned per-task factory below:
// resolution may itself spawn a short-lived `node --version` verification
// process (harness/planner-command.js), and redoing that on every task/
// context-reset would add back exactly the kind of per-task process-spawn
// overhead this exists to reduce.
function makeHarnessPlanner() {
  const { command: plannerCommand, env: plannerEnv } = resolvePlannerCommand();
  let args = [];
  let configured = Boolean(process.env.HALO_PLANNER_COMMAND);
  if (process.env.HALO_PLANNER_ARGS) {
    try {
      args = JSON.parse(process.env.HALO_PLANNER_ARGS);
      configured = Array.isArray(args) && args.length > 0 && args.every((arg) => typeof arg === "string");
    } catch {
      configured = false;
    }
    if (!configured) {
      args = [];
      console.error("[harness] HALO_PLANNER_ARGS must be a non-empty JSON array of worker arguments");
    }
  }
  return () => {
    return new PlannerStdioAdapter({
      // A Node executable on PATH alone is not a configured agent worker.
      command: configured ? plannerCommand : null,
      args,
      cwd: REPO_ROOT,
      env: plannerEnv,
      // Host-owned hooks so every planner worker this app ever spawns is
      // counted in the same <1GB aggregate memory budget the Python
      // approver already is (see the memoryMonitor comment above) --
      // consumed by planner-stdio.js's own spawn/exit handling.
      onWorkerStart: ({ pid, creationTime }) => memoryMonitor.registerExternalProcess({ pid, creationTime, label: "planner" }),
      onWorkerExit: ({ pid, creationTime }) => memoryMonitor.unregister(pid, creationTime),
    });
  };
}

function createWindow(socketPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--halo-layout=${JSON.stringify(RENDERER_LAYOUT)}`],
    },
  });

  const controlApi = new ControlApi({ window: win, socketPath });
  const surfaces = new BrowserSurfaces(win, { isUserControlled: (taskId) => taskHost.canUseTaskBrowser(taskId) });
  const taskHost = new TaskHost({
    storageRoot: path.join(app.getPath("userData"), "harness-tasks"),
    makeBrowser: makeHarnessBrowser(surfaces),
    setViewport: (taskId, bounds) => surfaces.setViewport(taskId, bounds),
    makePlanner: makeHarnessPlanner(),
    hostVerifier: defaultHostVerifier,
    approve: makeHarnessApprove(socketPath),
    memoryMonitor,
  });
  taskHosts.add(taskHost);
  win.once("closed", () => {
    const closing = taskHost.close().catch((error) => {
      console.error("[harness] failed to close task resources:", error);
    }).finally(() => taskHosts.delete(taskHost));
    closingTaskHosts.push(closing);
  });
  registerIpc(win, controlApi, { taskHost });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  return win;
}

app.whenReady().then(() => {
  socketDir = makeSocketDir();
  const socketPath = path.join(socketDir, "approver.sock");
  approverProcess = spawnApprover(socketPath);
  createWindow(socketPath);

  // Background poll so task-controller.js's per-dispatch getPressureLevel()
  // check is always a cheap in-memory read, never a synchronous OS query in
  // the hot loop. 5s is a deliberate, disclosed tradeoff: real measurement
  // at a real cadence, not simulated -- but a purely userspace poll loop at
  // any interval cannot guarantee catching an instantaneous spike between
  // polls (see memory-monitor.js's own doc comment on this honest limit).
  memoryPollTimer = setInterval(() => {
    memoryMonitor.sample().catch(() => {
      // A failed sample (e.g. a transient ps error) just means the next
      // getPressureLevel() call still reflects the last successful sample --
      // never crash the app over a monitoring hiccup.
    });
  }, 5000);
  memoryMonitor.sample().catch(() => {});

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      Promise.allSettled(closingTaskHosts.splice(0)).then(() => createWindow(socketPath));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  if (memoryPollTimer) clearInterval(memoryPollTimer);
  Promise.allSettled([...taskHosts].map((host) => host.close()))
    .then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error("[harness] failed to close task resources:", result.reason);
      }
    })
    .finally(() => {
      if (approverProcess) approverProcess.kill();
      if (socketDir) {
        try {
          fs.rmSync(socketDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; a leftover empty tmp dir is not a safety issue.
        }
      }
      app.quit();
    });
});
