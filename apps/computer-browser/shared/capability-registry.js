// Generated from runtime-src/shared/capability-registry.ts. Do not edit; run npm run build:runtime.
"use strict";
// Closed, host-owned capability allowlist. A capability is a proposal/source
// route, not an authorization grant; every adapter still runs through the
// TaskController and shared policy/approval/evidence core.
const CAPABILITY_REGISTRY_VERSION = 1;
const CAPABILITY_IDS = Object.freeze(["browser", "computer_use", "multi_agent", "multi_agent_computer_use", "research", "routine"]);
function deepFreeze(value) {
    for (const child of Object.values(value)) {
        if (child && typeof child === "object" && !Object.isFrozen(child))
            deepFreeze(child);
    }
    return Object.freeze(value);
}
const REGISTRY = deepFreeze({
    browser: {
        id: "browser",
        available: true,
        dependencies: ["browser"],
        adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }],
    },
    computer_use: {
        id: "computer_use",
        available: true,
        dependencies: ["browser", "computer_use"],
        adapters: [
            { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
            { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
        ],
    },
    multi_agent: {
        id: "multi_agent",
        available: true,
        dependencies: ["browser", "multi_agent"],
        adapters: [
            { capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 },
            { capabilityId: "multi_agent", adapterId: "child-agent-coordinator", adapterVersion: 1 },
        ],
    },
    multi_agent_computer_use: {
        id: "multi_agent_computer_use",
        available: true,
        dependencies: ["browser", "computer_use", "multi_agent"],
        adapters: [
            { capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 },
            { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
            { capabilityId: "multi_agent", adapterId: "child-agent-coordinator", adapterVersion: 1 },
        ],
    },
    research: {
        id: "research",
        available: false,
        reasonCode: "capability_unavailable",
        reason: "source identity and evidence verification are not implemented",
        dependencies: ["browser", "research"],
        adapters: [],
    },
    routine: {
        id: "routine",
        available: true,
        dependencies: ["browser", "routine"],
        adapters: [
            { capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 },
            { capabilityId: "routine", adapterId: "routine-runner", adapterVersion: 1 },
        ],
    },
});
function getCapabilityProfile(id) {
    if (typeof id !== "string" || !Object.hasOwn(REGISTRY, id)) {
        throw Object.assign(new Error(`unknown capability ${String(id)}`), { code: "unknown_capability" });
    }
    return REGISTRY[id];
}
module.exports = {
    CAPABILITY_IDS,
    CAPABILITY_REGISTRY_VERSION,
    getCapabilityProfile,
};
