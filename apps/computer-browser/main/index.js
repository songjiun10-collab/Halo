"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const { ControlApi } = require("./control-api");
const registerIpc = require("./ipc");
const layoutConstants = require("../shared/layout-constants");

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
  });
  return child;
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
  registerIpc(win, controlApi);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  socketDir = makeSocketDir();
  const socketPath = path.join(socketDir, "approver.sock");
  approverProcess = spawnApprover(socketPath);
  createWindow(socketPath);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(socketPath);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (approverProcess) approverProcess.kill();
  if (socketDir) {
    try {
      fs.rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a leftover empty tmp dir is not a safety issue.
    }
  }
});
