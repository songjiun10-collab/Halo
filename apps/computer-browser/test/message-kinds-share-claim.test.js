"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const contracts = require("../shared/harness-contracts");

const base = { idempotencyKey: "k1", text: "I found the login form selector" };

test("share and claim are text message kinds; handoff stays the only structured kind", () => {
  for (const kind of ["share", "claim"]) {
    assert.ok(contracts.MESSAGE_KINDS.includes(kind), kind);
    assert.doesNotThrow(() => contracts.validateMessageContent({ ...base, kind }, "m"), kind);
    assert.throws(() => contracts.validateMessageContent({ idempotencyKey: "k1", kind }, "m"), /text/, `${kind} requires text`);
    assert.throws(() => contracts.validateMessageContent({ ...base, kind, handoff: {} }, "m"), /handoff/, `${kind} rejects handoff`);
  }
});
