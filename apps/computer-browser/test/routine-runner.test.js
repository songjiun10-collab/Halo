"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const { RoutineRunner } = require("../main/harness/routine-runner");
const { validateJournalEvent, validateProposalEnvelope } = require("../shared/harness-contracts");
const { validateRoutineDefinition, computeContentDigest } = require("../shared/routine-contracts");

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";

function definition(steps) {
  return {
    schemaVersion: 1,
    routineId: TASK_ID,
    revision: 1,
    name: "Route",
    description: "",
    origins: ["https://example.test"],
    steps,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    digest: "a".repeat(64),
  };
}

function context(observation) {
  return {
    taskId: TASK_ID,
    goalVersion: 2,
    observation: {
      id: "obs-1",
      documentEpoch: 1,
      url: "https://example.test/start",
      title: "Start",
      text: "",
      elements: [],
      at: "2026-09-29T00:00:01.000Z",
      ...observation,
    },
  };
}

function journal(type, payload) {
  return {
    seq: 1,
    eventId: EVENT_ID,
    taskId: TASK_ID,
    goalVersion: 2,
    type,
    payload,
    at: "2026-09-29T00:00:02.000Z",
  };
}

test("runner consumes the validated persisted definition shape", async () => {
  const content = {
    name: "Route",
    description: "",
    origins: ["https://example.test"],
    steps: [{ kind: "navigate", url: "https://example.test/next" }],
  };
  const persisted = validateRoutineDefinition({
    schemaVersion: 1,
    routineId: TASK_ID,
    revision: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...content,
    digest: computeContentDigest(content),
  });
  const runner = new RoutineRunner({ definition: persisted });
  assert.deepEqual((await runner.next(context({ url: "about:blank" }))).actions, [{ type: "navigate", url: "https://example.test/next" }]);
});

test("navigate proposes one action bound to the current task and observation; only durable advancement moves cursor", async () => {
  const step = { kind: "navigate", url: "https://example.test/next" };
  const runner = new RoutineRunner({ definition: definition([step]) });
  const first = await runner.next(context());
  assert.deepEqual(first, {
    taskId: TASK_ID,
    goalVersion: 2,
    basedOnObservationId: "obs-1",
    criterionIds: [],
    kind: "actions",
    actions: [{ type: "navigate", url: "https://example.test/next" }],
  });
  validateProposalEnvelope(first);
  assert.deepEqual(await runner.next(context()), first);
  const metadata = runner.getCurrentStep();
  assert.deepEqual(metadata, {
    routineId: TASK_ID,
    revision: 1,
    stepIndex: 0,
    stepDigest: createHash("sha256").update(JSON.stringify(step)).digest("hex"),
  });
  assert.equal(runner.advance(metadata), 1);
  assert.deepEqual(await runner.next(context()), {
    taskId: TASK_ID,
    goalVersion: 2,
    basedOnObservationId: "obs-1",
    criterionIds: [],
    kind: "finish",
    evidenceIds: [],
  });
});

test("follow_link resolves a single exact accessible link and proposes only its observed elementId", async () => {
  const runner = new RoutineRunner({ definition: definition([{ kind: "follow_link", name: "Next", expectedHref: "https://example.test/next" }]) });
  const proposal = await runner.next(context({ elements: [
    { elementId: "0", role: "link", name: "Next page", href: "https://example.test/wrong" },
    { elementId: "1", role: "link", name: "Next", href: "https://example.test/next" },
  ] }));
  assert.deepEqual(proposal.actions, [{ type: "follow_link", elementId: "1" }]);
  validateProposalEnvelope(proposal);
});

test("follow_link fails closed on zero or multiple exact matches and on a cross-origin target", async () => {
  const runner = new RoutineRunner({ definition: definition([{ kind: "follow_link", name: "Next" }]) });
  await assert.rejects(runner.next(context()), { code: "routine_step_unresolved" });
  await assert.rejects(runner.next(context({ elements: [
    { elementId: "0", role: "link", name: "Next", href: "https://example.test/a" },
    { elementId: "1", role: "link", name: "Next", href: "https://example.test/b" },
  ] })), { code: "routine_step_unresolved" });
  await assert.rejects(runner.next(context({ elements: [
    { elementId: "0", role: "link", name: "Next", href: "https://attacker.test/" },
  ] })), { code: "routine_origin_violation" });
});

test("navigate and scroll reject an off-allowlist current page or destination", async () => {
  const navigate = new RoutineRunner({ definition: definition([{ kind: "navigate", url: "https://attacker.test/" }]) });
  await assert.rejects(navigate.next(context({ url: "about:blank" })), { code: "routine_origin_violation" });
  const inScopeNavigate = new RoutineRunner({ definition: definition([{ kind: "navigate", url: "https://example.test/next" }]) });
  await assert.rejects(inScopeNavigate.next(context({ url: "https://attacker.test/" })), { code: "routine_origin_violation" });
  const scroll = new RoutineRunner({ definition: definition([{ kind: "scroll", direction: "down", amount: 200 }]) });
  await assert.rejects(scroll.next(context({ url: "https://attacker.test/" })), { code: "routine_origin_violation" });
  const proposal = await scroll.next(context());
  assert.deepEqual(proposal.actions, [{ type: "scroll", direction: "down", amount: 200 }]);
});

test("advance rejects a mismatched step digest and cannot skip a step", () => {
  const runner = new RoutineRunner({ definition: definition([{ kind: "scroll", direction: "down", amount: 100 }]) });
  assert.throws(() => runner.advance({ stepIndex: 1, stepDigest: "a".repeat(64) }), { code: "routine_cursor_mismatch" });
  assert.throws(() => runner.advance({ stepIndex: 0, stepDigest: "b".repeat(64) }), { code: "routine_cursor_mismatch" });
  assert.throws(() => runner.advance({ ...runner.getCurrentStep(), routineId: "other" }), { code: "routine_cursor_mismatch" });
  assert.throws(() => runner.advance({ stepIndex: 0, stepDigest: runner.getCurrentStep().stepDigest }), { code: "routine_cursor_mismatch" });
  assert.equal(runner.getCurrentStep().stepIndex, 0);
});

test("constructor refuses a forged non-HTTP or non-normalized origin allowlist", () => {
  const input = definition([{ kind: "navigate", url: "https://example.test/next" }]);
  assert.throws(() => new RoutineRunner({ definition: { ...input, origins: ["file:///"] } }), { code: "invalid_routine" });
  assert.throws(() => new RoutineRunner({ definition: { ...input, origins: ["https://EXAMPLE.test/"] } }), { code: "invalid_routine" });
});

test("a caller cannot change a pinned step or allowlist after runner construction", async () => {
  const input = definition([{ kind: "navigate", url: "https://example.test/safe" }]);
  const runner = new RoutineRunner({ definition: input });
  input.steps[0].url = "https://attacker.test/unsafe";
  input.origins.push("https://attacker.test");
  assert.deepEqual((await runner.next(context())).actions, [{ type: "navigate", url: "https://example.test/safe" }]);
});

test("routine advancement and denial journal events require exact bounded payloads", () => {
  const base = { routineId: TASK_ID, revision: 1, stepIndex: 0, stepDigest: "a".repeat(64) };
  assert.equal(validateJournalEvent(journal("routine_step_advanced", { ...base, actionId: "action-1" })).type, "routine_step_advanced");
  assert.equal(validateJournalEvent(journal("routine_step_denied", { ...base, decision: "deny", reasons: ["policy"] })).type, "routine_step_denied");
  assert.equal(validateJournalEvent(journal("routine_step_failed", { ...base, actionId: "action-1", status: "failed", errorCode: "stale_document" })).type, "routine_step_failed");
  assert.throws(() => validateJournalEvent(journal("routine_step_advanced", { ...base, actionId: "action-1", extra: true })), { code: "unknown_field" });
  assert.throws(() => validateJournalEvent(journal("routine_step_advanced", { ...base, actionId: "action-1", stepDigest: "short" })), { code: "invalid_field" });
  assert.throws(() => validateJournalEvent(journal("routine_step_denied", { ...base, decision: "allow", reasons: ["policy"] })), { code: "unknown_enum" });
  assert.throws(() => validateJournalEvent(journal("routine_step_denied", { ...base, decision: "deny", reasons: Array(65).fill("x") })), { code: "field_too_large" });
  assert.throws(() => validateJournalEvent(journal("routine_step_failed", { ...base, actionId: "action-1", status: "ok" })), { code: "unknown_enum" });
});

test("with read-only batching, consecutive scroll steps become one proposal capped at three actions", async () => {
  const steps = [1, 2, 3, 4].map((amount) => ({ kind: "scroll", direction: "down", amount }));
  const runner = new RoutineRunner({ definition: definition(steps), batchReadOnlySteps: true });
  const proposal = await runner.next(context());
  assert.equal(proposal.kind, "actions");
  assert.deepEqual(proposal.actions, [1, 2, 3].map((amount) => ({ type: "scroll", direction: "down", amount })));
  assert.equal(runner.getCurrentStep().stepIndex, 0, "proposing does not advance the cursor");
  for (let i = 0; i < 3; i += 1) runner.advance(runner.getCurrentStep());
  const rest = await runner.next(context());
  assert.deepEqual(rest.actions, [{ type: "scroll", direction: "down", amount: 4 }]);
});

test("with read-only batching, a scroll batch stops at the next non-scroll step", async () => {
  const steps = [
    { kind: "scroll", direction: "down" },
    { kind: "navigate", url: "https://example.test/next" },
    { kind: "scroll", direction: "up" },
  ];
  const runner = new RoutineRunner({ definition: definition(steps), batchReadOnlySteps: true });
  assert.equal((await runner.next(context())).actions.length, 1);
  runner.advance(runner.getCurrentStep());
  const navigate = await runner.next(context());
  assert.deepEqual(navigate.actions, [{ type: "navigate", url: "https://example.test/next" }]);
});

test("without the option scroll steps stay one action per proposal", async () => {
  const steps = [{ kind: "scroll", direction: "down" }, { kind: "scroll", direction: "down" }];
  const runner = new RoutineRunner({ definition: definition(steps) });
  assert.equal((await runner.next(context())).actions.length, 1);
});
