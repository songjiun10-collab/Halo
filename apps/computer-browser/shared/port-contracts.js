// Generated from runtime-src/shared/port-contracts.ts. Do not edit; run npm run build:runtime.
"use strict";
// Plain-JSON transport seams. Signals become cancellation messages.
function deepFreeze(value) {
    for (const child of Object.values(value))
        if (child && typeof child === "object")
            deepFreeze(child);
    return Object.freeze(value);
}
const BROWSER_PORT = deepFreeze({
    requests: {
        observe: { signalArg: 0 },
        execute: { signalArg: 1 },
        userNavigate: {},
        fillCredential: {},
        dispose: {},
    },
    notifications: ["setPermissionMode"],
    mirrors: ["getBrowserSnapshot", "getDocumentEpoch"],
    events: ["onChange"],
});
const PLANNER_PORT = deepFreeze({
    requests: {
        next: { signalArg: 1 },
        close: {},
    },
    notifications: ["warm"],
    mirrors: [],
    events: [],
});
module.exports = { BROWSER_PORT, PLANNER_PORT };
