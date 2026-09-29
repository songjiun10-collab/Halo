"use strict";

// Opt-in smoke script (multi-agent background runtime plan, Task 1 steps
// 4-5): bootstraps a uniquely-named, disposable per-user macOS LaunchAgent
// that runs a throwaway Node fixture, confirms it actually started (ready
// marker + live PID), boots it out, and removes only the plist/temp files
// this run created. It never touches any other LaunchAgent, never installs
// anything persistent, and is never invoked by the "node --test" unit suite.
// Real Electron service-mode behavior is exercised separately in Task 7.
//
// macOS only -- skips (exit 0) on any other platform.
//
// Usage: node apps/computer-browser/integration/background-runtime-launchagent-smoke.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { resolveBackgroundServiceInvocation } = require("../main/harness/launch-agent-manager");

const READY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;
const BOOTOUT_CONFIRM_TIMEOUT_MS = 5_000;

function log(message) {
  process.stdout.write(`[launchagent-smoke] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runLaunchctl(args) {
  try {
    return execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString("utf8").trim() : "";
    throw new Error(`launchctl ${args.join(" ")} failed: ${stderr || error.message}`);
  }
}

function writeFixtureScript(fixturePath, markerPath) {
  const source = `"use strict";
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
setInterval(() => {}, 1000);
`;
  fs.writeFileSync(fixturePath, source, { mode: 0o600 });
}

function buildPlist({ label, executablePath, args, stdoutPath, stderrPath }) {
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const argLines = [executablePath, ...args].map((value) => `    <string>${escape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${escape(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escape(stderrPath)}</string>
</dict>
</plist>
`;
}

async function main() {
  if (process.platform !== "darwin") {
    log("not macOS; skipping (this smoke is opt-in and macOS-only)");
    return;
  }

  const uniqueId = `smoke-${crypto.randomUUID()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-launchagent-smoke-"));
  const fixturePath = path.join(tempDir, "fixture.js");
  const markerPath = path.join(tempDir, "ready.json");
  const stdoutPath = path.join(tempDir, "stdout.log");
  const stderrPath = path.join(tempDir, "stderr.log");

  // appPath is reused here as "the fixture's own entry script path" -- the
  // same generalization resolveBackgroundServiceInvocation() uses for
  // `electron <appPath>` in dev mode applies equally to `node <fixturePath>`.
  const invocation = resolveBackgroundServiceInvocation({
    executablePath: process.execPath,
    appPath: fixturePath,
    userId: uniqueId,
  });

  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${invocation.label}.plist`);
  if (fs.existsSync(plistPath)) {
    throw new Error(`refusing to overwrite an existing plist at ${plistPath}`);
  }

  const uid = process.getuid();
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${invocation.label}`;
  let bootstrapped = false;

  try {
    writeFixtureScript(fixturePath, markerPath);
    fs.writeFileSync(
      plistPath,
      buildPlist({
        label: invocation.label,
        executablePath: invocation.executablePath,
        args: invocation.arguments,
        stdoutPath,
        stderrPath,
      }),
      { mode: 0o600 },
    );

    log(`bootstrapping disposable LaunchAgent ${invocation.label}`);
    runLaunchctl(["bootstrap", domainTarget, plistPath]);
    bootstrapped = true;

    const marker = await waitFor(() => {
      if (!fs.existsSync(markerPath)) return null;
      try {
        return JSON.parse(fs.readFileSync(markerPath, "utf8"));
      } catch {
        return null;
      }
    }, READY_TIMEOUT_MS, POLL_INTERVAL_MS);

    if (!marker || typeof marker.pid !== "number") {
      throw new Error("fixture never wrote a ready marker within the timeout");
    }
    if (!isProcessAlive(marker.pid)) {
      throw new Error(`fixture marker pid ${marker.pid} is not a live process`);
    }
    log(`fixture confirmed ready: pid=${marker.pid}`);

    log("booting out the disposable LaunchAgent");
    runLaunchctl(["bootout", serviceTarget]);
    bootstrapped = false;

    const goneWithinTimeout = await waitFor(
      () => (isProcessAlive(marker.pid) ? null : true),
      BOOTOUT_CONFIRM_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    if (!goneWithinTimeout) {
      log(`warning: pid ${marker.pid} still observable ${BOOTOUT_CONFIRM_TIMEOUT_MS}ms after bootout (best-effort check only)`);
    } else {
      log("confirmed the fixture process exited after bootout");
    }

    log("PASS: LaunchAgent bootstrap -> ready -> bootout succeeded end to end");
  } finally {
    if (bootstrapped) {
      try {
        runLaunchctl(["bootout", serviceTarget]);
      } catch {
        // best-effort cleanup; nothing else to do if this fails too
      }
    }
    fs.rmSync(plistPath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[launchagent-smoke] FAIL: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
