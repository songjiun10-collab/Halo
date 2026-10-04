"use strict";

// Plain-JSON transport seams. Signals become cancellation messages.
function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
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
} as const);

const PLANNER_PORT = deepFreeze({
  requests: {
    next: { signalArg: 1 },
    close: {},
  },
  notifications: ["warm"],
  mirrors: [],
  events: [],
} as const);

export = { BROWSER_PORT, PLANNER_PORT };
