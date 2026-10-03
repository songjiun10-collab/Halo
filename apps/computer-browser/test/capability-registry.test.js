"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CAPABILITY_IDS,
  CAPABILITY_REGISTRY_VERSION,
  getCapabilityProfile,
} = require("../shared/capability-registry");

test("registry is a closed, versioned allowlist with only implemented adapters available", () => {
  assert.equal(CAPABILITY_REGISTRY_VERSION, 1);
  assert.deepEqual(CAPABILITY_IDS, ["browser", "computer_use", "multi_agent", "multi_agent_computer_use", "research", "routine"]);
  assert.deepEqual(getCapabilityProfile("browser"), {
    id: "browser", available: true, dependencies: ["browser"],
    adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }],
  });
  assert.equal(getCapabilityProfile("routine").available, true);
  assert.equal(getCapabilityProfile("multi_agent").available, true);
  assert.equal(getCapabilityProfile("research").available, false);
  assert.equal(getCapabilityProfile("research").reasonCode, "capability_unavailable");
  assert.deepEqual(getCapabilityProfile("computer_use"), {
    id: "computer_use", available: true, dependencies: ["browser", "computer_use"],
    adapters: [
      { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
      { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
    ],
  });
  assert.equal(getCapabilityProfile("multi_agent").adapters.some((item) => item.capabilityId === "computer_use"), false,
    "ordinary team tasks do not require image-capable planners");
  assert.ok(getCapabilityProfile("multi_agent_computer_use").adapters.some((item) => item.capabilityId === "computer_use"),
    "explicit CUA team tasks expose screenshot-grounded actions under the parent's own review queue");
  assert.throws(() => getCapabilityProfile("unknown"), { code: "unknown_capability" });
});

test("registry results are immutable copies and adapter closure is sorted", () => {
  const entry = getCapabilityProfile("multi_agent");
  assert.deepEqual(entry.dependencies, [...entry.dependencies].sort());
  assert.deepEqual(entry.adapters, [...entry.adapters].sort((a, b) =>
    `${a.capabilityId}:${a.adapterId}`.localeCompare(`${b.capabilityId}:${b.adapterId}`)));
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.dependencies));
  assert.ok(Object.isFrozen(entry.adapters));
  assert.throws(() => getCapabilityProfile("routine").dependencies.push("research"));
});
