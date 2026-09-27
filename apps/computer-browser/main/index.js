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
const { PlannerStdioAdapter } = require("./harness/planner-stdio");
const { MemoryMonitor } = require("./harness/memory-monitor");

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

// One dedicated, invisible WebContentsView per harness task -- never the
// same view the legacy ControlApi demo drives, so a long-horizon task can
// never be confused with (or fight over) the visible demo surface. Not
// attached to any window's visible layout; BrowserAdapter never needs
// visibility, only a real Chromium document to observe/execute against.
function makeHarnessBrowser(win) {
  return () => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    win.contentView.addChildView(view);
    view.setVisible(false);
    return new BrowserAdapter({ view });
  };
}

// Planner worker command comes ONLY from trusted host config (env vars set
// by whoever launches this Electron app) -- never from the UI, a page, or
// the model itself (design doc section 6). With nothing configured, the
// adapter stays honestly "unavailable" (PlannerStdioAdapter throws
// PlannerTransportError("planner_unavailable", ...) from next()) rather
// than fabricating a natural-language-sounding proposal; task-controller.js
// surfaces that as paused:planner_unavailable.
function makeHarnessPlanner() {
  return () => {
    let args = [];
    if (process.env.HALO_PLANNER_ARGS) {
      try {
        args = JSON.parse(process.env.HALO_PLANNER_ARGS);
      } catch {
        args = [];
      }
    }
    return new PlannerStdioAdapter({ command: process.env.HALO_PLANNER_COMMAND || null, args, cwd: REPO_ROOT });
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
  const taskHost = new TaskHost({
    storageRoot: path.join(app.getPath("userData"), "harness-tasks"),
    makeBrowser: makeHarnessBrowser(win),
    makePlanner: makeHarnessPlanner(),
    hostVerifier: defaultHostVerifier,
    approve: makeHarnessApprove(socketPath),
    memoryMonitor,
  });
  registerIpc(win, controlApi, { taskHost });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow(socketPath);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (memoryPollTimer) clearInterval(memoryPollTimer);
  if (approverProcess) approverProcess.kill();
  if (socketDir) {
    try {
      fs.rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a leftover empty tmp dir is not a safety issue.
    }
  }
});
