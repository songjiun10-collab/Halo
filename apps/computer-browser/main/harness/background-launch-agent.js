// Generated from runtime-src/main/harness/background-launch-agent.ts. Do not edit; run npm run build:runtime.
"use strict";
// The manager remains JavaScript; this structural boundary avoids pulling
// unrelated implementation files into the strict runtime-source build.
const { LaunchAgentManager, resolveBackgroundServiceInvocation } = require("./launch-agent-manager");
const MAX_USER_ID = 128;
function launchAgentUserId({ username, uid } = {}) {
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
        enable: ({ deferStart = false } = {}) => deferStart ? manager.install(job) : manager.update(job),
        disable: () => manager.remove({ label: invocation.label }),
    });
}
module.exports = { launchAgentUserId, createBackgroundLaunchAgent };
