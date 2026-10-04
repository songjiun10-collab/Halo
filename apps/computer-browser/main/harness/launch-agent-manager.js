"use strict";

// Background-runtime plan Task 1: describes how the background service would
// be launched by a per-user macOS LaunchAgent. This module is deliberately
// pure -- it never shells out to launchctl, never writes a plist, and never
// installs anything. Real LaunchAgent bootstrap/bootout/install/uninstall
// (plan Task 5 step 6) builds ON TOP of this resolver's output; it does not
// live here, so this contract stays unit-testable without a real macOS
// environment or launchd.

const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const LABEL_PREFIX = "com.halo.computerbrowser.background";
const SERVICE_FLAG = "--halo-background-service";
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class LaunchAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LaunchAgentError";
    this.code = code;
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new LaunchAgentError("invalid_path", `${label} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw new LaunchAgentError("invalid_path", `${label} must be an absolute path`);
  }
}

// Deliberately does NOT read process.argv, process.env, or any other
// ambient/UI-process state -- every field of the result is derived solely
// from these three explicit arguments, so a background-service invocation
// can never accidentally inherit a UI-only flag (e.g. --halo-layout=...)
// that only makes sense for the renderer's BrowserWindow.
function resolveBackgroundServiceInvocation({ executablePath, appPath, userId } = {}) {
  assertAbsolutePath(executablePath, "executablePath");
  if (appPath !== undefined && appPath !== null) {
    assertAbsolutePath(appPath, "appPath");
  }
  if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new LaunchAgentError(
      "invalid_user_id",
      "userId must be 1-128 characters of letters, digits, dot, underscore, or hyphen",
    );
  }

  const label = `${LABEL_PREFIX}.${userId}`;
  const args = appPath ? [appPath, SERVICE_FLAG] : [SERVICE_FLAG];

  return Object.freeze({
    label,
    executablePath,
    arguments: Object.freeze(args),
  });
}

// ---- Task 5 step 6: install/start/stop/update/remove ----
//
// Everything below builds ON TOP of resolveBackgroundServiceInvocation()'s
// pure output. Filesystem and launchctl access is confined to
// LaunchAgentManager, and both are injectable (launchAgentsDir, runLaunchctl,
// uid) so unit tests exercise the real bootstrap/bootout/plist-write logic
// against a temporary directory and a fake launchctl recorder -- never a
// real user's ~/Library/LaunchAgents or the real launchd. Every operation
// here is meant to be invoked only from trusted main-process code in
// response to an explicit user action (e.g. a settings toggle), never from
// the renderer directly.

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Pure -- builds the plist XML text. No filesystem or launchctl access.
// ProgramArguments is always an explicit array (executablePath followed by
// each argument), never a joined shell string, so launchd execs the
// background service directly with no shell in between.
function generatePlist({ label, executablePath, arguments: args, stdoutPath, stderrPath } = {}) {
  if (typeof label !== "string" || label.length === 0) {
    throw new LaunchAgentError("invalid_field", "label must be a non-empty string");
  }
  assertAbsolutePath(executablePath, "executablePath");
  if (!Array.isArray(args)) {
    throw new LaunchAgentError("invalid_field", "arguments must be an array");
  }

  const argLines = [executablePath, ...args].map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  const extraKeys = [];
  if (stdoutPath !== undefined && stdoutPath !== null) {
    assertAbsolutePath(stdoutPath, "stdoutPath");
    extraKeys.push(`  <key>StandardOutPath</key><string>${escapeXml(stdoutPath)}</string>`);
  }
  if (stderrPath !== undefined && stderrPath !== null) {
    assertAbsolutePath(stderrPath, "stderrPath");
    extraKeys.push(`  <key>StandardErrorPath</key><string>${escapeXml(stderrPath)}</string>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key><true/>
${extraKeys.join("\n")}
</dict>
</plist>
`;
}

async function defaultRunLaunchctl(args) {
  try {
    const { stdout } = await execFileAsync("launchctl", args);
    return stdout;
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString("utf8").trim() : "";
    throw new LaunchAgentError("launchctl_failed", `launchctl ${args.join(" ")} failed: ${stderr || error.message}`);
  }
}

class LaunchAgentManager {
  constructor({ launchAgentsDir, runLaunchctl, uid } = {}) {
    this._launchAgentsDir = launchAgentsDir || path.join(os.homedir(), "Library", "LaunchAgents");
    this._runLaunchctl = runLaunchctl || defaultRunLaunchctl;
    const resolvedUid = uid !== undefined ? uid : typeof process.getuid === "function" ? process.getuid() : null;
    if (typeof resolvedUid !== "number") {
      throw new LaunchAgentError("unsupported_platform", "LaunchAgentManager requires a POSIX uid (macOS only)");
    }
    this._uid = resolvedUid;
  }

  _plistPath(label) {
    return path.join(this._launchAgentsDir, `${label}.plist`);
  }

  _domainTarget() {
    return `gui/${this._uid}`;
  }

  _serviceTarget(label) {
    return `${this._domainTarget()}/${label}`;
  }

  // A LaunchAgents directory entry is, in principle, writable by anything
  // running as the same user -- never follow a symlink planted at the
  // target plist path, mirroring background-runtime-ipc.js's socket-path
  // symlink defense.
  async _assertNotSymlink(targetPath) {
    let stat;
    try {
      stat = await fs.lstat(targetPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new LaunchAgentError("symlink_rejected", `${targetPath} is a symlink; refusing to use it`);
    }
  }

  // Writes the plist file. Does not load it into launchd -- call start()
  // (or update(), for an existing label) as a separate, explicit step.
  async install({ label, executablePath, arguments: args, stdoutPath, stderrPath }) {
    const plistPath = this._plistPath(label);
    await this._assertNotSymlink(plistPath);
    await fs.mkdir(this._launchAgentsDir, { recursive: true, mode: 0o755 });
    const xml = generatePlist({ label, executablePath, arguments: args, stdoutPath, stderrPath });
    await fs.writeFile(plistPath, xml, { mode: 0o600 });
    return { plistPath };
  }

  // Loads the plist into the caller's per-user launchd domain. Because the
  // generated plist sets RunAtLoad, a successful bootstrap also starts the
  // process immediately.
  async start({ label }) {
    const plistPath = this._plistPath(label);
    await this._assertNotSymlink(plistPath);
    await this._runLaunchctl(["bootstrap", this._domainTarget(), plistPath]);
    return { serviceTarget: this._serviceTarget(label) };
  }

  // Unloads the job from launchd entirely by its full service target --
  // an explicit stop that launchd will never resurrect on its own (this
  // module does not opt into any KeepAlive/crash-restart policy).
  async stop({ label }) {
    await this._runLaunchctl(["bootout", this._serviceTarget(label)]);
    return { serviceTarget: this._serviceTarget(label) };
  }

  // Best-effort stop (a not-yet-loaded job has nothing to boot out) ->
  // rewrite the plist -> start, in that order.
  async update({ label, executablePath, arguments: args, stdoutPath, stderrPath }) {
    try {
      await this.stop({ label });
    } catch {
      // Not currently loaded; nothing to stop before rewriting.
    }
    await this.install({ label, executablePath, arguments: args, stdoutPath, stderrPath });
    return this.start({ label });
  }

  // Read-only: is this label's plist present as a regular file? A symlink
  // planted at the path is never reported as installed. Does not ask
  // launchd whether the job is loaded.
  async isInstalled({ label } = {}) {
    if (typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(label)) {
      throw new LaunchAgentError("invalid_field", "label must be a plain launchd label");
    }
    try {
      const stat = await fs.lstat(this._plistPath(label));
      return stat.isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  // Best-effort stop -> delete the plist file.
  async remove({ label }) {
    try {
      await this.stop({ label });
    } catch {
      // Not currently loaded; nothing to stop before removing the plist.
    }
    const plistPath = this._plistPath(label);
    await this._assertNotSymlink(plistPath);
    await fs.rm(plistPath, { force: true });
    return { plistPath };
  }
}

module.exports = {
  resolveBackgroundServiceInvocation,
  LaunchAgentError,
  LaunchAgentManager,
  generatePlist,
  LABEL_PREFIX,
  SERVICE_FLAG,
};
