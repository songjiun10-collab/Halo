"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decideTeamRoute, CrossTeamLeases, TeamConversationLog, requestTeamHelp, TeamCommsError } = require("../main/harness/team-comms-policy");

const A = { teamId: "A", leadTaskId: "a-lead", members: ["a-lead", "a1"] };
const B = { teamId: "B", leadTaskId: "b-lead", members: ["b-lead", "b1"] };
const teams = [A, B];

test("same-team traffic is direct; cross-team traffic is lead-routed", () => {
  assert.deepEqual(decideTeamRoute({ teams, from: "a1", to: "a-lead" }), { route: "direct" });
  assert.deepEqual(decideTeamRoute({ teams, from: "a-lead", to: "b-lead" }), { route: "lead_to_lead" });
  assert.deepEqual(decideTeamRoute({ teams, from: "a1", to: "b1" }), { route: "via_leads", via: ["a-lead", "b-lead"] });
  assert.deepEqual(decideTeamRoute({ teams, from: "a1", to: "b-lead" }), { route: "via_leads", via: ["a-lead"] });
});

test("unknown participants and over-deep relays are refused", () => {
  assert.throws(() => decideTeamRoute({ teams, from: "zz", to: "b1" }), { code: "unknown_task" });
  assert.throws(() => decideTeamRoute({ teams, from: "a-lead", to: "b-lead", hops: 3, maxDepth: 2 }), { code: "depth_limit" });
});

test("a cross-team lease is per ordered pair, expires, and can be revoked", () => {
  let t = 0;
  const leases = new CrossTeamLeases({ ttlMs: 1000, now: () => t });
  leases.grant("A", "B", "help with login");
  assert.equal(leases.active("A", "B"), true);
  assert.equal(leases.active("B", "A"), false, "a lease is not symmetric");
  assert.throws(() => leases.grant("A", "B", "again"), { code: "lease_exists" });
  t = 1000;
  assert.equal(leases.active("A", "B"), false);
  leases.grant("A", "B", "later");
  leases.revoke("A", "B");
  assert.equal(leases.active("A", "B"), false);
});

test("requestTeamHelp addresses the other team's lead and needs a lease", () => {
  const leases = new CrossTeamLeases({ ttlMs: 1000, now: () => 0 });
  assert.throws(() => requestTeamHelp({ teams, leases, from: "a-lead", toTeamId: "B", text: "x" }), { code: "no_lease" });
  leases.grant("A", "B", "p");
  const req = requestTeamHelp({ teams, leases, from: "a-lead", toTeamId: "B", text: "need selectors" });
  assert.deepEqual(req, { recipientTaskId: "b-lead", messageKind: "question", text: "need selectors" });
  assert.throws(() => requestTeamHelp({ teams, leases, from: "a1", toTeamId: "B", text: "x" }), { code: "not_lead" });
});

test("the team conversation log records messages and revocation hides them", () => {
  const log = new TeamConversationLog();
  log.record({ id: "m1", fromTeam: "A", toTeam: "B", text: "hi" });
  assert.equal(log.list("A", "B").length, 1);
  log.revoke("A", "B");
  assert.equal(log.list("A", "B").length, 0);
});
