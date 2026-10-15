"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { draftContract, describeContract, contractReceipt } = require("../main/harness/task-contract");

test("contract origins come from the start URL and URLs the user typed", () => {
  const c = draftContract({ goal: "compare https://a.example/x and https://b.example.", startUrl: "https://start.example/home" });
  assert.deepEqual(c.origins, ["https://a.example", "https://b.example", "https://start.example"]);
});

test("a goal with no URL and no start page yields no lock, and says so", () => {
  const c = draftContract({ goal: "find me a laptop" });
  assert.equal(c.lock, null);
  assert.match(describeContract(c), /without a site limit/);
});

test("receipt blocks exfil navigation and form submit, and flags budget overrun", () => {
  const c = draftContract({ goal: "read my notes", startUrl: "https://notes.example", stepBudget: 2 });
  const r = contractReceipt(c, [
    { action: "navigate", targetOrigin: "https://notes.example" },
    { action: "navigate", targetOrigin: "https://exfil.example" },
    { action: "submit_form", targetOrigin: "https://notes.example" },
  ]);
  assert.equal(r.allowed.length, 1);
  assert.deepEqual(r.blocked.map((b) => b.reason), ["lock_origin_denied", "lock_action_denied"]);
  assert.equal(r.withinBudget, false);
});

test("page-supplied text cannot widen the contract (goal only)", () => {
  const c = draftContract({ goal: "summarise this page", startUrl: "https://notes.example" });
  assert.deepEqual(c.origins, ["https://notes.example"]);
});
