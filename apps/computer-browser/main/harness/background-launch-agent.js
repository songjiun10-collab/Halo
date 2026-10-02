"use strict";

// "Start at login" for the background service: the per-user LaunchAgent
// built from resolveBackgroundServiceInvocation(). Only an explicit user
// toggle (BackgroundRuntimeUi.setLaunchAtLogin) calls enable/disable.
//
// The label's user part is the macOS account name with anything outside
// [A-Za-z0-9._-] replaced, so each account on the Mac gets its own label;
// a name that leaves nothing usable falls back to uid-<uid>.

const { LaunchAgentManager, resolveBackgroundServiceInvocation } = require("./launch-agent-manager");

const MAX_USER_ID = 128;

function launchAgentUserId({ username, uid } = {}) {
  const cleaned = String(username ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_USER_ID);
  return cleaned || `uid-${Number.isInteger(uid) ? uid : 0}`;
}

// enable(): writes the plist and bootstraps it, which also starts the service
// now (RunAtLoad). disable(): boots it out and deletes the plist.
function createBackgroundLaunchAgent({ manager = new LaunchAgentManager(), executablePath, appPath, userId, logPath } = {}) {
  const invocation = resolveBackgroundServiceInvocation({ executablePath, appPath, userId });
  const job = {
    label: invocation.label,
    executablePath: invocation.executablePath,
    arguments: [...invocation.arguments],
    ...(logPath ? { stdoutPath: logPath, stderrPath: logPath } : {}),
  };
  return Object.freeze({
    label: invocation.label,
    isInstalled: () => manager.isInstalled({ label: invocation.label }),
    enable: () => manager.update(job),
    disable: () => manager.remove({ label: invocation.label }),
  });
}

module.exports = { launchAgentUserId, createBackgroundLaunchAgent };
