"use strict";

// Closed, host-owned capability allowlist. A capability is a proposal/source
// route, not an authorization grant; every adapter still runs through the
// TaskController and shared policy/approval/evidence core.

const CAPABILITY_REGISTRY_VERSION = 1;
const CAPABILITY_IDS = Object.freeze(["browser", "computer_use", "multi_agent", "research", "routine"]);

type CapabilityAdapter = { capabilityId: string, adapterId: string, adapterVersion: number };
type CapabilityProfile = {
  id: string,
  available: boolean,
  reasonCode?: string,
  reason?: string,
  dependencies: string[],
  adapters: CapabilityAdapter[],
};

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const REGISTRY: Readonly<Record<string, Readonly<CapabilityProfile>>> = deepFreeze({
  browser: {
    id: "browser",
    available: true,
    dependencies: ["browser"],
    adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }],
  },
  computer_use: {
    id: "computer_use",
    available: false,
    reasonCode: "capability_unavailable",
    reason: "screenshot provenance and coordinate-action verification are not implemented",
    dependencies: ["computer_use"],
    adapters: [],
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

function getCapabilityProfile(id: unknown): Readonly<CapabilityProfile> {
  if (typeof id !== "string" || !Object.hasOwn(REGISTRY, id)) {
    throw Object.assign(new Error(`unknown capability ${String(id)}`), { code: "unknown_capability" });
  }
  return REGISTRY[id];
}

export = {
  CAPABILITY_IDS,
  CAPABILITY_REGISTRY_VERSION,
  getCapabilityProfile,
};
