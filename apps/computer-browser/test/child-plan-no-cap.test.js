"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const contracts = require("../shared/harness-contracts");

const proposal = (n) => ({
  taskId: "11111111-1111-4111-8111-111111111111", goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [],
  kind: "child_plan", parentGoalVersion: 1, requestedAgentCount: n,
  assignments: Array.from({ length: n }, (_, i) => ({ subgoal: `Task ${i}`, entryUrl: `https://s${i}.example/` })),
});

test("a child plan of any size is accepted; the coordinator decides the agent count", () => {
  for (const n of [8, 9, 16, 40]) assert.doesNotThrow(() => contracts.validateProposalEnvelope(proposal(n)), String(n));
  assert.throws(() => contracts.validateProposalEnvelope({ ...proposal(2), requestedAgentCount: 3 }), /requestedAgentCount/);
});
