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
  assert.deepEqual(CAPABILITY_IDS, ["browser", "computer_use", "multi_agent", "research", "routine"]);
  assert.deepEqual(getCapabilityProfile("browser"), {
    id: "browser", available: true, dependencies: ["browser"],
    adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }],
  });
  assert.equal(getCapabilityProfile("routine").available, true);
  assert.equal(getCapabilityProfile("multi_agent").available, true);
  assert.equal(getCapabilityProfile("research").available, false);
  assert.equal(getCapabilityProfile("research").reasonCode, "capability_unavailable");
  assert.equal(getCapabilityProfile("computer_use").available, false);
  assert.equal(getCapabilityProfile("computer_use").reasonCode, "capability_unavailable");
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
