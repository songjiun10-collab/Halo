"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeGoalSpec } = require("../shared/harness-contracts");
const { validateProposal, verifyCriterion, canComplete, ProgressError } = require("../main/harness/progress");

const TASK_ID = "11111111-1111-1111-1111-111111111111";

function makeGoal({ goalVersion = 1, ...goalInputOverrides } = {}) {
  return normalizeGoalSpec(
    {
      originalRequest: "3페이지를 읽고 요약해줘",
      criteria: [
        { id: "C1", text: "originalRequest를 달성했고 사용자가 결과를 확인했다", required: true, verification: "user" },
        { id: "host-check", text: "3페이지를 모두 방문했다", required: true, verification: "host" },
      ],
      ...goalInputOverrides,
    },
    { taskId: TASK_ID, goalVersion, createdAt: new Date().toISOString() },
  );
}

function makeEvidence(overrides = {}) {
  return {
    id: "ev1",
    taskId: TASK_ID,
    goalVersion: 1,
    criterionId: "host-check",
    kind: "host_check",
    at: new Date().toISOString(),
    verification: "pending",
    ...overrides,
  };
}

function baseProposal(goal, overrides = {}) {
  return {
    taskId: goal.taskId,
    goalVersion: goal.goalVersion,
    basedOnObservationId: "obs-1",
    criterionIds: ["host-check"],
    kind: "actions",
    actions: [{ type: "observe" }],
    ...overrides,
  };
}

test("validateProposal accepts a well-formed, on-goal proposal", () => {
  const goal = makeGoal();
  const proposal = baseProposal(goal);
  const validated = validateProposal(proposal, { goal });
  assert.equal(validated.kind, "actions");
});

test("validateProposal rejects an unknown criterionId as off_goal", () => {
  const goal = makeGoal();
  const proposal = baseProposal(goal, { criterionIds: ["not-a-real-criterion"] });
  assert.throws(() => validateProposal(proposal, { goal }), (err) => err instanceof ProgressError && err.code === "off_goal");
});

test("validateProposal rejects a stale goalVersion", () => {
  const goal = makeGoal();
  const proposal = baseProposal(goal, { goalVersion: goal.goalVersion + 1 });
  assert.throws(
    () => validateProposal(proposal, { goal }),
    (err) => err instanceof ProgressError && err.code === "stale_goal_version",
  );
});

test("validateProposal rejects a proposal for a different task", () => {
  const goal = makeGoal();
  const proposal = baseProposal(goal, { taskId: "22222222-2222-2222-2222-222222222222" });
  assert.throws(() => validateProposal(proposal, { goal }), (err) => err instanceof ProgressError && err.code === "wrong_task");
});

test("validateProposal enforces the shared wire shape (unknown kind, bad batch size)", () => {
  const goal = makeGoal();
  assert.throws(() => validateProposal(baseProposal(goal, { kind: "bogus" }), { goal }));
  assert.throws(() =>
    validateProposal(
      baseProposal(goal, { actions: [{ type: "observe" }, { type: "observe" }, { type: "observe" }, { type: "observe" }] }),
      { goal },
    ),
  );
});

test("verifyCriterion never trusts a model-supplied verification status directly -- only the injected hostVerifier decides", () => {
  const goal = makeGoal();
  const criterion = goal.criteria.find((c) => c.id === "host-check");
  const evidence = [makeEvidence({ verification: "pending" })];

  const verdictPending = verifyCriterion(criterion, evidence, () => undefined);
  assert.equal(verdictPending.status, "pending");

  const verdictVerified = verifyCriterion(criterion, evidence, () => true);
  assert.equal(verdictVerified.status, "verified");
  assert.equal(verdictVerified.evidenceId, "ev1");

  const verdictRejected = verifyCriterion(criterion, evidence, () => false);
  assert.equal(verdictRejected.status, "rejected");
});

test("verifyCriterion for a user-verification criterion requires a real confirmed evidence entry, not a hostVerifier verdict", () => {
  const goal = makeGoal();
  const criterion = goal.criteria.find((c) => c.id === "C1");

  const unconfirmed = [makeEvidence({ id: "ev2", criterionId: "C1", kind: "user_confirmation", verification: "pending" })];
  const stillPending = verifyCriterion(criterion, unconfirmed, () => true); // hostVerifier must be ignored for kind=user
  assert.equal(stillPending.status, "pending");

  const confirmed = [
    makeEvidence({ id: "ev3", criterionId: "C1", kind: "user_confirmation", verification: "verified", verifierId: "user-ipc" }),
  ];
  const verdict = verifyCriterion(criterion, confirmed, () => false); // hostVerifier must still be ignored
  assert.equal(verdict.status, "verified");
  assert.equal(verdict.evidenceId, "ev3");
});

test("canComplete reports awaiting_verification when a required criterion has no verified evidence yet", () => {
  const goal = makeGoal();
  const evidence = [makeEvidence({ verification: "verified", verifierId: "host" })]; // only host-check is covered, not C1
  const result = canComplete(goal, evidence);
  assert.equal(result.complete, false);
  assert.equal(result.status, "awaiting_verification");
  assert.deepEqual(result.missingIds, ["C1"]);
});

test("canComplete reports completed once every required criterion has verified evidence for the current goalVersion", () => {
  const goal = makeGoal();
  const evidence = [
    makeEvidence({ verification: "verified", verifierId: "host" }),
    makeEvidence({ id: "ev-c1", criterionId: "C1", kind: "user_confirmation", verification: "verified", verifierId: "user-ipc" }),
  ];
  const result = canComplete(goal, evidence);
  assert.equal(result.complete, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.missingIds, []);
});

test("canComplete does not let evidence verified under an old goalVersion silently satisfy the amended goal", () => {
  const goalV1 = makeGoal();
  const evidenceUnderV1 = [
    makeEvidence({ verification: "verified", verifierId: "host" }),
    makeEvidence({ id: "ev-c1", criterionId: "C1", kind: "user_confirmation", verification: "verified", verifierId: "user-ipc" }),
  ];
  assert.equal(canComplete(goalV1, evidenceUnderV1).complete, true);

  const goalV2 = makeGoal({ goalVersion: 2 });
  const stillComplete = canComplete(goalV2, evidenceUnderV1);
  assert.equal(stillComplete.complete, false);
  assert.deepEqual(stillComplete.missingIds.sort(), ["C1", "host-check"]);
});

test("a criterion with no evidence at all defaults to C1-style awaiting_verification, not silently satisfied", () => {
  const goal = makeGoal();
  const result = canComplete(goal, []);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingIds.sort(), ["C1", "host-check"]);
});
