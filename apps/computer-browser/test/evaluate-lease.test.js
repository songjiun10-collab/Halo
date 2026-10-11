"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EvaluateLeases } = require("../main/harness/evaluate-lease");

test("evaluate needs an active lease for that task and origin", () => {
  let t = 0;
  const l = new EvaluateLeases({ ttlMs: 1000, maxUses: 2, now: () => t });
  assert.deepEqual(l.authorize("t1", "https://a.example"), { allowed: false, reason: "no_lease" });
  l.grant("t1", "https://a.example", "read a table value");
  assert.equal(l.authorize("t1", "https://a.example").allowed, true);
  assert.deepEqual(l.authorize("t1", "https://b.example"), { allowed: false, reason: "no_lease" });
  assert.deepEqual(l.authorize("t2", "https://a.example"), { allowed: false, reason: "no_lease" });
});

test("a lease is limited by use count and by time, and is audited", () => {
  let t = 0;
  const l = new EvaluateLeases({ ttlMs: 1000, maxUses: 2, now: () => t });
  l.grant("t1", "https://a.example", "why");
  l.authorize("t1", "https://a.example");
  l.authorize("t1", "https://a.example");
  assert.deepEqual(l.authorize("t1", "https://a.example"), { allowed: false, reason: "uses_exhausted" });
  l.grant("t1", "https://a.example", "again");
  t = 1000;
  assert.deepEqual(l.authorize("t1", "https://a.example"), { allowed: false, reason: "expired" });
  assert.equal(l.audit().filter((e) => e.type === "grant").length, 2);
  assert.ok(l.audit().some((e) => e.type === "use"));
});

test("revoke ends a lease immediately", () => {
  const l = new EvaluateLeases({ ttlMs: 1000, maxUses: 5, now: () => 0 });
  l.grant("t1", "https://a.example", "why");
  l.revoke("t1", "https://a.example");
  assert.equal(l.authorize("t1", "https://a.example").allowed, false);
});
