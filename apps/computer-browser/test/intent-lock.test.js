"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const contracts = require("../shared/harness-contracts");
const { TaskStore } = require("../main/harness/task-store");

const { makeIntentLock, validateIntentLock, evaluateLock, lockDigest } = contracts;

test("a lock is canonical: origins normalized, sorted and de-duplicated, digest stable", () => {
  const a = makeIntentLock({ rules: [{ kind: "allow_origins", origins: ["https://GitHub.com/", "https://example.com", "https://github.com"] }, { kind: "deny_action", action: "follow_link" }] });
  const b = makeIntentLock({ rules: [{ kind: "allow_origins", origins: ["https://example.com", "https://github.com"] }, { kind: "deny_action", action: "follow_link" }] });
  assert.deepEqual(a.rules[0].origins, ["https://example.com", "https://github.com"]);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, lockDigest(a.rules));
});

test("lock rules reject unknown kinds, unknown actions, non-http origins and oversize lists", () => {
  for (const rules of [
    [{ kind: "deny_payment_forms" }],
    [{ kind: "deny_action", action: "observe" }],
    [{ kind: "allow_origins", origins: ["file:///etc"] }],
    [{ kind: "allow_origins", origins: ["https://u:p@example.com"] }],
    [{ kind: "deny_origins", origins: [] }],
    [{ kind: "deny_action", action: "navigate", extra: 1 }],
    Array.from({ length: 9 }, () => ({ kind: "deny_action", action: "navigate" })),
    [{ kind: "deny_origins", origins: Array.from({ length: 21 }, (_, i) => `https://h${i}.example`) }],
  ]) {
    assert.throws(() => makeIntentLock({ rules }), (e) => e instanceof contracts.ContractError, JSON.stringify(rules));
  }
});

test("a tampered digest is storage_corrupt", () => {
  const lock = makeIntentLock({ rules: [{ kind: "deny_action", action: "navigate" }] });
  assert.throws(() => validateIntentLock({ ...lock, digest: "0".repeat(64) }, "lock"), (e) => e.code === "storage_corrupt");
  assert.throws(() => validateIntentLock({ rules: [{ kind: "deny_action", action: "follow_link" }], digest: lock.digest }, "lock"), (e) => e.code === "storage_corrupt");
});

test("evaluateLock: deny_action, allow_origins, deny_origins, and an absent lock", () => {
  const lock = makeIntentLock({ rules: [
    { kind: "deny_action", action: "follow_link" },
    { kind: "allow_origins", origins: ["https://github.com", "https://example.com"] },
    { kind: "deny_origins", origins: ["https://example.com"] },
  ] });
  assert.deepEqual(evaluateLock(null, { action: "navigate", targetOrigin: "https://x.test" }), { allowed: true });
  assert.deepEqual(evaluateLock(lock, { action: "follow_link", targetOrigin: "https://github.com" }), { allowed: false, reason: "lock_action_denied", ruleIndex: 0 });
  assert.deepEqual(evaluateLock(lock, { action: "navigate", targetOrigin: "https://github.com" }), { allowed: true });
  assert.deepEqual(evaluateLock(lock, { action: "navigate", targetOrigin: "https://other.test" }), { allowed: false, reason: "lock_origin_denied", ruleIndex: 1 });
  assert.deepEqual(evaluateLock(lock, { action: "navigate", targetOrigin: null }), { allowed: false, reason: "lock_origin_denied", ruleIndex: 1 });
  assert.deepEqual(evaluateLock(lock, { action: "navigate", targetOrigin: "https://example.com" }), { allowed: false, reason: "lock_origin_denied", ruleIndex: 2 });
  assert.deepEqual(evaluateLock(lock, { action: "navigate" }), { allowed: true }, "undefined origin skips origin rules");
  assert.deepEqual(evaluateLock(lock, { action: "scroll", targetOrigin: "https://other.test" }), { allowed: true }, "read-only actions ignore origin rules");
});

async function store(goalInput) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-intent-lock-"));
  return { storageRoot, store: await TaskStore.create(goalInput, { storageRoot }) };
}

test("a task keeps its lock across amendments, a user amendment may replace or clear it", async () => {
  const { store: s } = await store({ originalRequest: "book", lock: { rules: [{ kind: "deny_action", action: "navigate" }] } });
  const first = s.getGoal().lock;
  assert.equal(first.rules[0].action, "navigate");
  const kept = await s.amendGoal({ text: "also compare prices" });
  assert.deepEqual(kept.lock, first);
  const replaced = await s.amendGoal({ text: "only github", lock: { rules: [{ kind: "allow_origins", origins: ["https://github.com"] }] } });
  assert.equal(replaced.lock.rules[0].kind, "allow_origins");
  const cleared = await s.amendGoal({ text: "no limits", lock: null });
  assert.equal(cleared.lock, undefined);
  await s.close();
});

test("a goal file whose lock was edited on disk does not open", async () => {
  const { store: s, storageRoot } = await store({ originalRequest: "book", lock: { rules: [{ kind: "deny_action", action: "navigate" }] } });
  const taskId = s.getGoal().taskId;
  await s.close();
  const file = path.join(storageRoot, "tasks", taskId, "goal-v0001.json");
  const goal = JSON.parse(await fs.readFile(file, "utf8"));
  goal.lock.rules = [];
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, JSON.stringify(goal));
  await assert.rejects(TaskStore.load(taskId, { storageRoot }), (e) => e.code === "storage_corrupt");
});

test("lease events are journal types with strict payloads", () => {
  const base = { seq: 1, eventId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", goalVersion: 1, at: new Date().toISOString() };
  const leaseId = "33333333-3333-4333-8333-333333333333";
  const ok = [
    { type: "lease_granted", payload: { leaseId, action: "navigate", origin: "https://github.com", expiresAt: 1_000, uses: 3 } },
    { type: "lease_used", payload: { leaseId, requestId: "44444444-4444-4444-8444-444444444444" } },
    { type: "lease_revoked", payload: { leaseId, reason: "goal_amended" } },
    { type: "lease_revoked", payload: { leaseId, reason: "user" } },
    { type: "lease_revoked", payload: { leaseId, reason: "request_stale" } },
    { type: "lease_revoked", payload: { leaseId, reason: "task_ended" } },
    { type: "lease_revoked", payload: { leaseId, reason: "taken_over" } },
  ];
  for (const e of ok) contracts.validateJournalEvent({ ...base, ...e });
  const bad = [
    { type: "lease_granted", payload: { leaseId, action: "scroll", origin: "https://github.com", expiresAt: 1, uses: 1 } },
    { type: "lease_granted", payload: { leaseId, action: "navigate", origin: "https://github.com", expiresAt: 1, uses: 4 } },
    { type: "lease_granted", payload: { leaseId, action: "navigate", origin: "https://github.com/path", expiresAt: 1, uses: 1 } },
    { type: "lease_revoked", payload: { leaseId, reason: "planner" } },
    { type: "lease_used", payload: { leaseId } },
  ];
  for (const e of bad) assert.throws(() => contracts.validateJournalEvent({ ...base, ...e }), contracts.ContractError, JSON.stringify(e));
});

test("no planner, room or MCP module writes a lock", async () => {
  const dir = path.join(__dirname, "../main/harness");
  for (const file of ["planner-command.js", "room-orchestrator.js", "generic-mcp-broker.js", "child-agent-coordinator.js", "agent-service.js"]) {
    let source = await fs.readFile(path.join(dir, file), "utf8");
    // A child inherits its parent's user-authored lock verbatim and nothing
    // else: that one copy is the only lock the coordinator may set.
    if (file === "child-agent-coordinator.js") {
      const inherited = source.match(/\block\s*:\s*\{\s*rules:\s*parentLock\.rules\s*\}/g) || [];
      assert.equal(inherited.length, 1, "child-agent-coordinator.js copies the parent's lock exactly once");
      source = source.replace(/\block\s*:\s*\{\s*rules:\s*parentLock\.rules\s*\}/g, "");
    }
    assert.doesNotMatch(source, /\block\s*:/, `${file} must not set a goal lock`);
  }
});

test("TaskHost.lendTask/revokeTaskLease require an attached task like approveTask", async () => {
  const { TaskHost, TaskHostError } = require("../main/harness/task-host");
  const host = Object.create(TaskHost.prototype);
  host._require = () => { throw new TaskHostError("task_not_found", "x"); };
  await assert.rejects(() => host.lendTask("t", "r", { minutes: 5, uses: 1 }), TaskHostError);
  await assert.rejects(() => host.revokeTaskLease("t", "l"), TaskHostError);
  const calls = [];
  host._require = () => ({ controller: { lend: async (...a) => { calls.push(["lend", ...a]); return "S"; }, revokeLease: async (...a) => { calls.push(["revoke", ...a]); return "S"; } } });
  assert.equal(await host.lendTask("t", "r", { minutes: 5, uses: 1 }), "S");
  assert.equal(await host.revokeTaskLease("t", "l"), "S");
  assert.deepEqual(calls, [["lend", "r", { minutes: 5, uses: 1 }], ["revoke", "l"]]);
});
