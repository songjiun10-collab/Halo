"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TeamBudgets, TeamBudgetError } = require("../main/harness/team-budgets");

test("a team spends from its own budget and is refused when exhausted", () => {
  const b = new TeamBudgets({ perTeam: { actions: 3, messages: 2 }, crossTeam: { messages: 1 } });
  b.spend("A", "actions", 2);
  b.spend("A", "actions", 1);
  assert.throws(() => b.spend("A", "actions", 1), { code: "budget_exhausted" });
  b.spend("B", "actions", 1);
  assert.deepEqual(b.remaining("A"), { actions: 0, messages: 2 });
  assert.deepEqual(b.remaining("B"), { actions: 2, messages: 2 });
});

test("cross-team messages draw on a separate per-pair budget", () => {
  const b = new TeamBudgets({ perTeam: { messages: 5 }, crossTeam: { messages: 1 } });
  b.spendCrossTeam("A", "B", "messages", 1);
  assert.throws(() => b.spendCrossTeam("A", "B", "messages", 1), { code: "budget_exhausted" });
  b.spendCrossTeam("B", "A", "messages", 1);
  assert.equal(b.remaining("A").messages, 5, "cross-team spend does not touch the team budget");
});

test("releasing a team returns its unspent budget to the pool and forgets it", () => {
  const b = new TeamBudgets({ perTeam: { actions: 4 }, crossTeam: {}, pool: { actions: 10 } });
  b.spend("A", "actions", 1);
  const freed = b.release("A");
  assert.deepEqual(freed, { actions: 3 });
  assert.deepEqual(b.poolRemaining(), { actions: 13 });
  assert.throws(() => b.spend("A", "actions", 1), { code: "unknown_team" });
});
