"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeIntentLock } = require("../shared/harness-contracts");
const { lendTerms, createLease, isLeaseLive, findLease, LeaseError } = require("../main/harness/capability-lease");
const { evaluateGate, actionTargetOrigin } = require("../main/harness/action-gate");

const T0 = 1_000_000;
const lease = (over = {}) => ({ ...createLease({ id: "l1", taskId: "t", action: "navigate", origin: "https://github.com", now: T0, minutes: 10, uses: 3 }), ...over });

test("lend terms can only shrink from 10 minutes / 3 uses", () => {
  assert.deepEqual(lendTerms(), { minutes: 10, uses: 3 });
  assert.deepEqual(lendTerms({ minutes: 2, uses: 1 }), { minutes: 2, uses: 1 });
  for (const bad of [{ minutes: 11 }, { uses: 4 }, { minutes: 0 }, { uses: 1.5 }, { minutes: "5" }]) {
    assert.throws(() => lendTerms(bad), (e) => e instanceof LeaseError && e.code === "invalid_lease_terms");
  }
});

test("a lease dies at expiry, when used up, or when revoked", () => {
  const l = lease();
  assert.equal(l.expiresAt, T0 + 10 * 60_000);
  assert.equal(isLeaseLive(l, T0), true);
  assert.equal(isLeaseLive(l, l.expiresAt), false, "expiry instant is already dead");
  assert.equal(isLeaseLive({ ...l, usesLeft: 0 }, T0), false);
  assert.equal(isLeaseLive({ ...l, revoked: true }, T0), false);
});

test("findLease matches action and origin and picks the earliest expiry", () => {
  const late = lease({ id: "late", deadline: T0 + 9 * 60_000 });
  const early = lease({ id: "early", deadline: T0 + 60_000 });
  const other = lease({ id: "other", origin: "https://x.test" });
  assert.equal(findLease([late, other, early], { action: "navigate", origin: "https://github.com" }, T0).id, "early");
  assert.equal(findLease([late], { action: "follow_link", origin: "https://github.com" }, T0), null);
  assert.equal(findLease([late], { action: "navigate", origin: null }, T0), null);
});

test("lease authorization deadline is monotonic and display expiry stays wall-clock based", () => {
  const l = createLease({ id: "mono", taskId: "t", action: "navigate", origin: "https://github.com", now: 5_000, wallNow: 9_000_000, minutes: 2, uses: 1 });
  assert.equal(l.expiresAt, 9_120_000);
  assert.equal(l.deadline, 125_000);
  assert.equal(isLeaseLive(l, 124_999), true);
  assert.equal(isLeaseLive(l, 125_000), false, "monotonic deadline is exclusive");
});

test("the lock beats every mode and lease, including full", () => {
  const lock = makeIntentLock({ rules: [{ kind: "deny_action", action: "navigate" }] });
  for (const mode of ["observe", "browse", "interact", "full"]) {
    const g = evaluateGate({ lock, mode, leases: [lease()], action: "navigate", targetOrigin: "https://github.com", now: T0 });
    assert.equal(g.outcome, "lock_denied", mode);
  }
});

test("mode-denied actions carry a matching lease; bypass and read-only never do", () => {
  const leases = [lease()];
  const denied = evaluateGate({ lock: null, mode: "observe", leases, action: "navigate", targetOrigin: "https://github.com", now: T0 });
  assert.equal(denied.outcome, "mode_denied");
  assert.equal(denied.lease.id, "l1");
  const allowed = evaluateGate({ lock: null, mode: "browse", leases, action: "navigate", targetOrigin: "https://github.com", now: T0 });
  assert.equal(allowed.outcome, "mode_allowed");
  assert.equal(allowed.lease.id, "l1", "a lease may stand in for a review in an allowed mode");
  assert.equal(evaluateGate({ lock: null, mode: "full", leases, action: "navigate", targetOrigin: "https://github.com", now: T0 }).lease, null);
  assert.equal(evaluateGate({ lock: null, mode: "observe", leases, action: "scroll", targetOrigin: "https://github.com", now: T0 }).lease, null);
  assert.equal(evaluateGate({ lock: null, mode: "full", leases, action: "download", targetOrigin: "https://github.com", now: T0 }).lease, null);
});

test("target origin comes from the URL, the observed link, or the current page", () => {
  const obs = { url: "https://page.test/a", elements: [{ elementId: "3", href: "https://github.com/x" }] };
  assert.equal(actionTargetOrigin({ type: "navigate", url: "https://github.com/a?b" }, obs), "https://github.com");
  assert.equal(actionTargetOrigin({ type: "follow_link", elementId: "3" }, obs), "https://github.com");
  assert.equal(actionTargetOrigin({ type: "follow_link", elementId: "9" }, obs), null);
  assert.equal(actionTargetOrigin({ type: "scroll" }, obs), "https://page.test");
  assert.equal(actionTargetOrigin({ type: "navigate", url: "not a url" }, obs), null);
  assert.equal(actionTargetOrigin({ type: "scroll" }, null), null);
});

test("interaction review uses the observed link or form destination rather than a planner URL", () => {
  const obs = { url: "https://page.test/", elements: [
    { elementId: "0", role: "link", href: "https://links.test/" },
    { elementId: "1", role: "button", formAction: "https://submit.test/", formMethod: "post" },
  ] };
  assert.equal(actionTargetOrigin({ type: "click", elementId: "0", url: "https://attacker.test/" }, obs), "https://links.test");
  assert.equal(actionTargetOrigin({ type: "submit_form", elementId: "1" }, obs), "https://submit.test");
  assert.equal(actionTargetOrigin({ type: "click", elementId: "1" }, obs), "https://submit.test");
  assert.equal(actionTargetOrigin({ type: "submit_form", elementId: "99" }, obs), null);
});

test("coordinate actions are scoped to the current observed origin and require interact permission", () => {
  const obs = { url: "https://page.test/path", elements: [] };
  assert.equal(actionTargetOrigin({ type: "click_at", observationId: "obs", x: 0.4, y: 0.2 }, obs), "https://page.test");
  assert.equal(actionTargetOrigin({ type: "type_at", observationId: "obs", x: 0.4, y: 0.2, text: "x" }, obs), "https://page.test");
  assert.equal(evaluateGate({ lock: null, mode: "interact", leases: [], action: "click_at", targetOrigin: "https://page.test", now: T0 }).policy.approval, "human");
  assert.equal(evaluateGate({ lock: null, mode: "interact", leases: [], action: "type_at", targetOrigin: "https://page.test", now: T0 }).policy.approval, "human");
});
