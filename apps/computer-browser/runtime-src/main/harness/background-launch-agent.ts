"use strict";

// "Start at login" for the background service: the per-user LaunchAgent
// built from resolveBackgroundServiceInvocation(). Only an explicit user
// toggle (BackgroundRuntimeUi.setLaunchAtLogin) calls enable/disable.
//
// The label's user part is the macOS account name with anything outside
// [A-Za-z0-9._-] replaced, so each account on the Mac gets its own label;
// a name that leaves nothing usable falls back to uid-<uid>.

interface InvocationOptions {
  executablePath?: string;
  appPath?: string | null;
  userId?: string;
}
interface BackgroundServiceInvocation {
  label: string;
  executablePath: string;
  arguments: readonly string[];
}
interface LaunchAgentJob {
  label: string;
  executablePath: string;
  arguments: string[];
  stdoutPath?: string;
  stderrPath?: string;
}
interface LaunchAgentManagerApi {
  isInstalled(options: { label: string }): unknown;
  install(job: LaunchAgentJob): unknown;
  update(job: LaunchAgentJob): unknown;
  remove(options: { label: string }): unknown;
}
interface LaunchAgentOptions extends InvocationOptions {
  manager?: LaunchAgentManagerApi;
  logPath?: string | null;
}
interface LaunchAgentUserOptions {
  username?: unknown;
  uid?: unknown;
}
interface EnableOptions {
  deferStart?: boolean;
}

// The manager remains JavaScript; this structural boundary avoids pulling
// unrelated implementation files into the strict runtime-source build.
const { LaunchAgentManager, resolveBackgroundServiceInvocation } = require("./launch-agent-manager") as {
  LaunchAgentManager: new () => LaunchAgentManagerApi;
  resolveBackgroundServiceInvocation(options: InvocationOptions): BackgroundServiceInvocation;
};

const MAX_USER_ID = 128;

function launchAgentUserId({ username, uid }: LaunchAgentUserOptions = {}): string {
  const cleaned = String(username ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_USER_ID);
  return cleaned || `uid-${Number.isInteger(uid) ? uid : 0}`;
}

// enable(): writes the plist and normally bootstraps it now (RunAtLoad).
// Call with {deferStart:true} when a local TaskHost still owns shared storage;
// launchd will start the service at the next login instead. disable(): boots
// it out and deletes the plist.
function createBackgroundLaunchAgent({ manager = new LaunchAgentManager(), executablePath, appPath, userId, logPath }: LaunchAgentOptions = {}) {
  const invocation = resolveBackgroundServiceInvocation({ executablePath, appPath, userId });
  const job: LaunchAgentJob = {
    label: invocation.label,
    executablePath: invocation.executablePath,
    arguments: [...invocation.arguments],
    ...(logPath ? { stdoutPath: logPath, stderrPath: logPath } : {}),
  };
  return Object.freeze({
    label: invocation.label,
    isInstalled: () => manager.isInstalled({ label: invocation.label }),
    enable: ({ deferStart = false }: EnableOptions = {}) => deferStart ? manager.install(job) : manager.update(job),
    disable: () => manager.remove({ label: invocation.label }),
  });
}

export = { launchAgentUserId, createBackgroundLaunchAgent };
