"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EVENT_TYPES, validateJournalEvent } = require("../shared/harness-contracts");

const id = "11111111-1111-4111-8111-111111111111";

function event(type, payload) {
  return {
    seq: 1,
    eventId: "22222222-2222-4222-8222-222222222222",
    taskId: id,
    goalVersion: 1,
    type,
    payload,
    at: "2026-09-29T00:00:00.000Z",
  };
}

test("goal_created accepts legacy payloads and the profile-required marker only", () => {
  assert.ok(EVENT_TYPES.includes("task_profile_selected"));
  assert.doesNotThrow(() => validateJournalEvent(event("goal_created", {})));
  assert.doesNotThrow(() => validateJournalEvent(event("goal_created", { goalVersion: 1 })));
  assert.doesNotThrow(() => validateJournalEvent(event("goal_created", { goalVersion: 1, profileRequired: true })));
  assert.throws(() => validateJournalEvent(event("goal_created", { goalVersion: 1, profileRequired: false })), { code: "invalid_field" });
  assert.throws(() => validateJournalEvent(event("goal_created", { goalVersion: 1, profileRequired: true, other: true })), { code: "unknown_field" });
});

test("task_profile_selected delegates exact payload validation to the profile contract", () => {
  assert.throws(() => validateJournalEvent(event("task_profile_selected", { profileSchemaVersion: 1 })), { code: "invalid_field" });
});
