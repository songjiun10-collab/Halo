"use strict";

// The two seams the coordinator talks through. Everything crossing them is
// plain JSON; AbortSignals never cross, they become cancel messages.
//   requests:      async request/reply; signalArg = index of the options
//                  argument that carries a caller AbortSignal (if any)
//   notifications: fire-and-forget, no reply
//   mirrors:       synchronous getters served from state the far side pushes
//                  (piggybacked on replies and change events)
//   events:        subscriptions (listener(snapshot) -> unsubscribe)

function deepFreeze(value) {
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
