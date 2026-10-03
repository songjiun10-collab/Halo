# Intent Lock + Capability Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each task a user-only Intent Lock (host-enforced rules + a digest) and let the user lend a time/use/origin-scoped Capability Lease from the approval sheet, including for actions the current permission mode would deny.

**Architecture:** Lock rules live on the immutable GoalSpec (validated and digest-checked in `harness-contracts`). A pure `evaluateGate` (lock → mode → lease) is used by `TaskController` before every planner action; `BrowserAdapter` re-checks the lock and refuses mode-denied actions unless the controller passes an explicit `widenedBy` grant. Leases are in-memory per controller with durable `lease_*` journal records; the approval sheet gains **Lend…**.

**Tech Stack:** Node `node:test` (apps/computer-browser), TypeScript runtime sources compiled by `npm run build:runtime`, React + Vite SSR tests (frontend).

Spec: `docs/superpowers/specs/2026-10-02-intent-lock-capability-lease-design.md`

## Global Constraints

- 기존 goal/epoch/admission/approval/durable journal/execution_uncertain 경계를 유지하고 새 자동 실행 우회를 만들지 않는다. Lease는 사용자가 승인창에서 명시적으로 빌려준 범위만 허용한다.
- Lock이 항상 이긴다: 어떤 mode·lease·`full` 모드로도 lock deny를 통과할 수 없다.
- approver의 `deny`/`quarantine`은 lease로 절대 덮지 않는다. Lease는 사람 승인 단계(review)와 mode deny만 대신한다.
- routine 실행과 `reviewFallback: "deny"`(무인 실행)에서는 mode deny가 지금처럼 거부로 끝난다(widen 큐잉 없음).
- adapter가 지원하지 않는 액션(`click`, `type`, `submit_form`, `download`)은 widen/lease 대상으로 큐에 올리지 않는다.
- `shared/harness-contracts.js`는 생성물이다. `runtime-src/shared/harness-contracts.ts`를 고치고 `npm run build:runtime`을 실행한다. 그 밖의 `main/harness/*.js`(browser-adapter, task-controller, task-host, permission-policy)는 직접 고친다.
- `frontend/**` 변경은 이번 작업에서 허가됨. `renderer/dist/**`는 커밋하지 않는다.
- 커밋은 사용자가 요청할 때만 한다. 아래 Commit 단계는 사용자 승인 후에만 실행한다.
- 테스트 실행: `cd apps/computer-browser && node --test test/<file>.test.js`; 프론트는 `cd frontend && node --experimental-strip-types --test test/<file>.test.mjs`.

## 스펙 대비 변경(구현 중 확인된 사실 반영)

1. `deny_payment_forms` 규칙은 이번 계획에서 제외한다. adapter가 `type`/`submit_form`을 아직 지원하지 않아 막을 입력이 없다. click/type 지원 시 별도 추가.
2. Lock의 자유 문장(notes)은 새 필드가 아니라 기존 `goal.constraints`를 그대로 쓴다(이미 사용자만 작성하고 planner 컨텍스트에 들어간다). 따라서 Lock 객체는 `{ rules, digest }`.
3. Lend 범위 상한은 기본값과 같다(10분, 3회). 사용자는 줄이기만 가능하므로 60분/20회 상한은 쓰이지 않는다.
4. 재시작 시 lease는 복원하지 않는다(모두 소멸). 복구된 task는 어차피 사람이 재개해야 하므로 더 보수적이다.
5. 사용자 결정에 따라 mode가 거부한 (지원되는) 액션은 조용히 건너뛰지 않고 approver를 거친 뒤 승인창에 올라간다("모드도 넓힘").

## File Structure

| File | Responsibility |
|---|---|
| `runtime-src/shared/harness-contracts.ts` (→ `shared/harness-contracts.js`) | Lock rule validation, canonical form, digest, `evaluateLock`; GoalSpec `lock` field; amendment `lock`; `lease_*` event types + payloads |
| `main/harness/capability-lease.js` (new) | Pure lease helpers: terms, create, liveness, lookup |
| `main/harness/action-gate.js` (new) | Pure `evaluateGate` (lock → mode → lease) and `actionTargetOrigin` |
| `main/harness/browser-adapter.js` | `setIntentLock`, `supportsAction`, `widenedBy` in `execute`, lock check in `_navigate`, navigation guard |
| `main/harness/task-controller.js` | Gate integration, widen queue items, `lend`, `revokeLease`, lease revoke on amend, snapshot fields |
| `main/harness/task-host.js`, `main/ipc.js`, `preload/index.js` | `lendTask`, `revokeTaskLease` IPC |
| `frontend/src/session/api.ts`, `session/types.ts`, `session/session.ts` | Types + `lend`/`revokeLease`/`createTask(lock)` |
| `frontend/src/components/HaloSheet.tsx` | Lend… UI |
| `frontend/src/components/LeaseChip.tsx` (new), `LockChips.tsx` (new) | Lease chip, composer lock chips |
| `frontend/src/components/HomeScreen.tsx`, `Viewport.tsx`, `App.tsx` | Wiring |

---

### Task 1: Intent Lock contract (rules, digest, evaluateLock, GoalSpec field)

**Files:**
- Modify: `apps/computer-browser/runtime-src/shared/harness-contracts.ts`
- Generated: `apps/computer-browser/shared/harness-contracts.js` (via `npm run build:runtime`)
- Test: `apps/computer-browser/test/intent-lock.test.js` (new)

**Interfaces:**
- Produces (exported from `shared/harness-contracts`):
  - `LOCK_ACTIONS: readonly ["navigate","follow_link","click","type","submit_form"]`
  - `makeIntentLock(input: { rules: unknown[] }): { rules: LockRule[]; digest: string }`
  - `validateIntentLock(lock: unknown, label: string): IntentLock` — throws `ContractError("storage_corrupt")` on digest mismatch
  - `lockDigest(rules: LockRule[]): string` (sha256 hex)
  - `evaluateLock(lock: IntentLock | null, q: { action: string; targetOrigin?: string | null }): { allowed: true } | { allowed: false; reason: "lock_action_denied" | "lock_origin_denied"; ruleIndex: number }`
    - `targetOrigin === undefined` → origin rules are not checked (caller checks origin elsewhere); `null` → unknown origin (fails `allow_origins`).
  - `normalizeLockOrigin(value: string): string`
  - GoalSpec gains optional `lock`; `normalizeGoalSpec` input accepts `lock: { rules }`; `applyAmendment` input accepts `lock: { rules } | null` (null clears) and otherwise carries the previous lock.
  - `LockRule = { kind: "deny_action"; action: LockAction } | { kind: "allow_origins" | "deny_origins"; origins: string[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/computer-browser/test/intent-lock.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/computer-browser && node --test test/intent-lock.test.js`
Expected: FAIL — `makeIntentLock is not a function`.

- [ ] **Step 3: Implement in `runtime-src/shared/harness-contracts.ts`**

Near the top (after `SCHEMA_VERSION`):

```ts
const { createHash } = require("node:crypto") as typeof import("node:crypto");
```

After `validateLimits` add:

```ts
const LOCK_ACTIONS = Object.freeze(["navigate", "follow_link", "click", "type", "submit_form"] as const);
type LockAction = (typeof LOCK_ACTIONS)[number];
type LockRule =
  | { kind: "deny_action"; action: LockAction }
  | { kind: "allow_origins" | "deny_origins"; origins: string[] };
interface IntentLock { rules: LockRule[]; digest: string }
const MAX_LOCK_RULES = 8;
const MAX_LOCK_ORIGINS = 20;
const ORIGIN_RULE_ACTIONS: ReadonlySet<string> = new Set(LOCK_ACTIONS);

function normalizeLockOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new ContractError("invalid_field", "lock origin must be a non-empty string");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new ContractError("invalid_field", "lock origin is not a URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new ContractError("invalid_field", "lock origin must be http(s) without credentials");
  }
  return url.origin;
}

function canonicalLockRule(rule: unknown, label: string): LockRule {
  assertPlainObject(rule, label);
  const r = rule as Record<string, unknown>;
  if (r.kind === "deny_action") {
    assertNoUnknownKeys(r, ["kind", "action"], label);
    if (!isOneOf(LOCK_ACTIONS, r.action)) {
      throw new ContractError("unknown_enum", `${label}.action must be one of ${LOCK_ACTIONS.join("|")}`);
    }
    return { kind: "deny_action", action: r.action as LockAction };
  }
  if (r.kind === "allow_origins" || r.kind === "deny_origins") {
    assertNoUnknownKeys(r, ["kind", "origins"], label);
    if (!Array.isArray(r.origins) || r.origins.length === 0 || r.origins.length > MAX_LOCK_ORIGINS) {
      throw new ContractError("invalid_field", `${label}.origins must hold 1-${MAX_LOCK_ORIGINS} origins`);
    }
    const origins = [...new Set(r.origins.map((o) => normalizeLockOrigin(o)))].sort();
    return { kind: r.kind, origins };
  }
  throw new ContractError("unknown_enum", `${label}.kind must be deny_action|allow_origins|deny_origins`);
}

function canonicalLockRules(rules: unknown, label: string): LockRule[] {
  if (!Array.isArray(rules)) throw new ContractError("invalid_field", `${label} must be an array`);
  if (rules.length > MAX_LOCK_RULES) throw new ContractError("field_too_large", `${label} exceeds ${MAX_LOCK_RULES} entries`);
  return rules.map((rule, i) => canonicalLockRule(rule, `${label}[${i}]`));
}

function lockDigest(rules: LockRule[]): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

function makeIntentLock(input: unknown): IntentLock {
  assertPlainObject(input, "lockInput");
  assertNoUnknownKeys(input as Record<string, unknown>, ["rules"], "lockInput");
  const rules = canonicalLockRules((input as Record<string, unknown>).rules, "lockInput.rules");
  return { rules, digest: lockDigest(rules) };
}

// Re-reads a stored lock. The rules must already be canonical and the digest
// must match: a goal file edited on disk is corrupt, never silently re-hashed.
function validateIntentLock(lock: unknown, label: string): IntentLock {
  assertPlainObject(lock, label);
  const l = lock as Record<string, unknown>;
  assertNoUnknownKeys(l, ["rules", "digest"], label);
  const rules = canonicalLockRules(l.rules, `${label}.rules`);
  if (typeof l.digest !== "string" || JSON.stringify(rules) !== JSON.stringify(l.rules) || lockDigest(rules) !== l.digest) {
    throw new ContractError("storage_corrupt", `${label} does not match its digest`);
  }
  return lock as IntentLock;
}

type LockVerdict = { allowed: true } | { allowed: false; reason: "lock_action_denied" | "lock_origin_denied"; ruleIndex: number };

/** Pure lock check. targetOrigin undefined = the caller checks origin elsewhere; null = unknown origin. */
function evaluateLock(lock: IntentLock | null | undefined, q: { action: string; targetOrigin?: string | null }): LockVerdict {
  if (!lock) return { allowed: true };
  for (let i = 0; i < lock.rules.length; i += 1) {
    const rule = lock.rules[i];
    if (rule.kind === "deny_action") {
      if (rule.action === q.action) return { allowed: false, reason: "lock_action_denied", ruleIndex: i };
      continue;
    }
    if (q.targetOrigin === undefined || !ORIGIN_RULE_ACTIONS.has(q.action)) continue;
    const listed = q.targetOrigin !== null && rule.origins.includes(q.targetOrigin);
    if (rule.kind === "allow_origins" ? !listed : listed) return { allowed: false, reason: "lock_origin_denied", ruleIndex: i };
  }
  return { allowed: true };
}
```

Add `"lock"` to `GOAL_SPEC_FIELDS`. In `validateGoalSpec`, after the trigger check:

```ts
  if (goal.lock !== undefined) validateIntentLock(goal.lock, `${label}.lock`);
```

In `normalizeGoalSpec`: add `"lock"` to the allowed input keys, and after the trigger assignment:

```ts
  if (input.lock !== undefined) goal.lock = makeIntentLock(input.lock);
```

In `applyAmendment`: add `"lock"` to the allowed `amendmentInput` keys and replace the trigger carry-over block with:

```ts
  if (goal.trigger !== undefined) nextGoal.trigger = goal.trigger;
  const lockInput = (amendmentInput as Record<string, unknown>).lock;
  if (lockInput === undefined) {
    if (goal.lock !== undefined) nextGoal.lock = goal.lock;
  } else if (lockInput !== null) {
    nextGoal.lock = makeIntentLock(lockInput);
  }
```

Update the GoalSpec TS type (wherever `trigger?:` is declared on the goal type) with `lock?: IntentLock`. Export from the module's `export =` block: `LOCK_ACTIONS, makeIntentLock, validateIntentLock, lockDigest, evaluateLock, normalizeLockOrigin`.

- [ ] **Step 4: Build and run**

Run: `cd apps/computer-browser && npm run build:runtime && node --test test/intent-lock.test.js test/harness-contracts.test.js test/task-store.test.js test/runtime-build.test.js`
Expected: PASS.

- [ ] **Step 5: Commit (only after the user asks)**

```bash
git add apps/computer-browser/runtime-src/shared/harness-contracts.ts apps/computer-browser/shared/harness-contracts.js apps/computer-browser/test/intent-lock.test.js
git commit -m "Add host-enforced Intent Lock rules to the goal contract"
```

---

### Task 2: Lease journal events

**Files:**
- Modify: `apps/computer-browser/runtime-src/shared/harness-contracts.ts`
- Generated: `apps/computer-browser/shared/harness-contracts.js`
- Test: `apps/computer-browser/test/intent-lock.test.js` (append)

**Interfaces:**
- Produces event types `lease_granted` `{ leaseId: uuid, action: LockAction, origin: string, expiresAt: number, uses: integer 1-3 }`, `lease_used` `{ leaseId: uuid, requestId: uuid }`, `lease_revoked` `{ leaseId: uuid, reason: "user" | "goal_amended" }`.

- [ ] **Step 1: Append failing tests**

```js
test("lease events are journal types with strict payloads", () => {
  const base = { seq: 1, eventId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", goalVersion: 1, at: new Date().toISOString() };
  const leaseId = "33333333-3333-4333-8333-333333333333";
  const ok = [
    { type: "lease_granted", payload: { leaseId, action: "navigate", origin: "https://github.com", expiresAt: 1_000, uses: 3 } },
    { type: "lease_used", payload: { leaseId, requestId: "44444444-4444-4444-8444-444444444444" } },
    { type: "lease_revoked", payload: { leaseId, reason: "goal_amended" } },
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
```

- [ ] **Step 2: Run** `node --test test/intent-lock.test.js` → FAIL (unknown type).

- [ ] **Step 3: Implement**

Append `"lease_granted", "lease_used", "lease_revoked"` to the end of `EVENT_TYPES`. In the event validator next to the `action_started` payload check add:

```ts
  if (event.type === "lease_granted") {
    const p = event.payload as Record<string, unknown>;
    assertNoUnknownKeys(p, ["leaseId", "action", "origin", "expiresAt", "uses"], `${label}.payload`);
    assertUuid(p.leaseId, `${label}.payload.leaseId`);
    if (!isOneOf(LOCK_ACTIONS, p.action)) throw new ContractError("unknown_enum", `${label}.payload.action is not leasable`);
    if (typeof p.origin !== "string" || normalizeLockOrigin(p.origin) !== p.origin) throw new ContractError("invalid_field", `${label}.payload.origin must be a bare origin`);
    assertPositiveInteger(p.expiresAt, `${label}.payload.expiresAt`);
    assertPositiveInteger(p.uses, `${label}.payload.uses`);
    if ((p.uses as number) > 3) throw new ContractError("invalid_field", `${label}.payload.uses exceeds 3`);
  }
  if (event.type === "lease_used") {
    const p = event.payload as Record<string, unknown>;
    assertNoUnknownKeys(p, ["leaseId", "requestId"], `${label}.payload`);
    assertUuid(p.leaseId, `${label}.payload.leaseId`);
    assertUuid(p.requestId, `${label}.payload.requestId`);
  }
  if (event.type === "lease_revoked") {
    const p = event.payload as Record<string, unknown>;
    assertNoUnknownKeys(p, ["leaseId", "reason"], `${label}.payload`);
    assertUuid(p.leaseId, `${label}.payload.leaseId`);
    if (!isOneOf(["user", "goal_amended"], p.reason)) throw new ContractError("unknown_enum", `${label}.payload.reason must be user|goal_amended`);
  }
```

- [ ] **Step 4:** `npm run build:runtime && node --test test/intent-lock.test.js test/task-events.test.js test/runtime-contract-conformance.test.js` → PASS.

- [ ] **Step 5: Commit (only after the user asks)** — `git commit -m "Add lease journal events"` with the three files.

---

### Task 3: Pure lease helpers and the action gate

**Files:**
- Create: `apps/computer-browser/main/harness/capability-lease.js`
- Create: `apps/computer-browser/main/harness/action-gate.js`
- Test: `apps/computer-browser/test/action-gate.test.js` (new)

**Interfaces:**
- `capability-lease.js` exports:
  - `LEASE_ACTIONS` = `["navigate","follow_link","click","type","submit_form"]`
  - `LEASE_DEFAULTS = { minutes: 10, uses: 3 }`
  - `class LeaseError extends Error { code }`
  - `lendTerms(terms?: { minutes?: number; uses?: number }): { minutes: number; uses: number }` — integers in 1..defaults, else `LeaseError("invalid_lease_terms")`
  - `createLease({ id, taskId, action, origin, now, minutes, uses }): Lease` where `Lease = { id, taskId, action, origin, grantedAt, expiresAt, usesLeft, revoked: false }`
  - `isLeaseLive(lease, now): boolean`
  - `findLease(leases, { action, origin }, now): Lease | null` (earliest expiry first)
- `action-gate.js` exports:
  - `actionTargetOrigin(action, lastObservation): string | null` — navigate → origin of `action.url`; follow_link → origin of the observed element's `href`; others → origin of `lastObservation.url`; unparsable → `null`
  - `evaluateGate({ lock, mode, leases, action, targetOrigin, now })` →
    `{ outcome: "lock_denied", reason, ruleIndex }` |
    `{ outcome: "mode_allowed", policy, lease: Lease | null }` |
    `{ outcome: "mode_denied", policy, lease: Lease | null }`
    (`policy` is `evaluateActionPolicy(mode, action)`; `lease` is null for `bypass`, for non-leasable actions, and for `unsupported_action`)

- [ ] **Step 1: Write the failing test** — `test/action-gate.test.js`:

```js
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
  const late = lease({ id: "late", expiresAt: T0 + 9 * 60_000 });
  const early = lease({ id: "early", expiresAt: T0 + 60_000 });
  const other = lease({ id: "other", origin: "https://x.test" });
  assert.equal(findLease([late, other, early], { action: "navigate", origin: "https://github.com" }, T0).id, "early");
  assert.equal(findLease([late], { action: "follow_link", origin: "https://github.com" }, T0), null);
  assert.equal(findLease([late], { action: "navigate", origin: null }, T0), null);
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
```

- [ ] **Step 2:** `node --test test/action-gate.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

`main/harness/capability-lease.js`:

```js
"use strict";

// Capability Lease: a user-lent, task-scoped permission for one action type on
// one origin, for a few minutes and a few uses. Pure helpers only; the task
// controller owns the list and journals every grant, use and revoke.

const LEASE_ACTIONS = Object.freeze(["navigate", "follow_link", "click", "type", "submit_form"]);
const LEASE_DEFAULTS = Object.freeze({ minutes: 10, uses: 3 });

class LeaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

// The sheet offers the defaults; the user can only shrink them.
function lendTerms(terms = {}) {
  const minutes = terms.minutes ?? LEASE_DEFAULTS.minutes;
  const uses = terms.uses ?? LEASE_DEFAULTS.uses;
  for (const [value, max] of [[minutes, LEASE_DEFAULTS.minutes], [uses, LEASE_DEFAULTS.uses]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new LeaseError("invalid_lease_terms", `lease terms must be whole numbers from 1 to ${max}`);
  }
  return { minutes, uses };
}

function createLease({ id, taskId, action, origin, now, minutes, uses }) {
  return { id, taskId, action, origin, grantedAt: now, expiresAt: now + minutes * 60_000, usesLeft: uses, revoked: false };
}

function isLeaseLive(lease, now) {
  return !lease.revoked && lease.usesLeft > 0 && now < lease.expiresAt;
}

function findLease(leases, { action, origin }, now) {
  if (!origin) return null;
  const live = leases.filter((l) => l.action === action && l.origin === origin && isLeaseLive(l, now));
  live.sort((a, b) => a.expiresAt - b.expiresAt);
  return live[0] ?? null;
}

module.exports = { LEASE_ACTIONS, LEASE_DEFAULTS, LeaseError, lendTerms, createLease, isLeaseLive, findLease };
```

`main/harness/action-gate.js`:

```js
"use strict";

// One verdict per planner action, in a fixed order: the user's Intent Lock
// first (nothing overrides it), then the permission mode, then any lease the
// user lent for this action and origin. Pure: the caller journals and acts.

const { evaluateLock } = require("../../shared/harness-contracts");
const { evaluateActionPolicy } = require("./permission-policy");
const { LEASE_ACTIONS, findLease } = require("./capability-lease");

function originOf(url) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function actionTargetOrigin(action, lastObservation) {
  if (action.type === "navigate") return typeof action.url === "string" ? originOf(action.url) : null;
  if (action.type === "follow_link") {
    const element = lastObservation?.elements?.find((el) => el.elementId === action.elementId);
    return element && typeof element.href === "string" ? originOf(element.href) : null;
  }
  return lastObservation && typeof lastObservation.url === "string" ? originOf(lastObservation.url) : null;
}

function evaluateGate({ lock, mode, leases, action, targetOrigin, now }) {
  const verdict = evaluateLock(lock ?? null, { action, targetOrigin });
  if (!verdict.allowed) return { outcome: "lock_denied", reason: verdict.reason, ruleIndex: verdict.ruleIndex };
  const policy = evaluateActionPolicy(mode, action);
  const leasable = LEASE_ACTIONS.includes(action) && policy.approval !== "bypass" && policy.reason !== "unsupported_action";
  const lease = leasable ? findLease(leases, { action, origin: targetOrigin }, now) : null;
  return { outcome: policy.allowed ? "mode_allowed" : "mode_denied", policy, lease };
}

module.exports = { actionTargetOrigin, evaluateGate };
```

- [ ] **Step 4:** `node --test test/action-gate.test.js test/permission-policy.test.js` → PASS.

- [ ] **Step 5: Commit (only after the user asks)** — `git commit -m "Add capability lease helpers and the action gate"`.

---

### Task 4: BrowserAdapter enforces the lock and accepts explicit widening only

**Files:**
- Modify: `apps/computer-browser/main/harness/browser-adapter.js` (constructor listeners ~L283-301, `setPermissionMode` ~L309, `execute` L539-555, `_navigate` ~L589)
- Test: `apps/computer-browser/test/browser-adapter.test.js` (append; reuse its `makeFakeView`)

**Interfaces:**
- Produces on `BrowserAdapter`:
  - `setIntentLock(lock: IntentLock | null): void`
  - `supportsAction(type: string): boolean`
  - `execute(action, { signal, documentEpoch, widenedBy })` — `widenedBy` is `null | { kind: "user_once" } | { kind: "lease", leaseId: string }`; a mode-denied action runs only when `widenedBy` is valid. Lock-denied actions return `{ status: "failed", errorCode: "intent_lock_denied" }` regardless.

- [ ] **Step 1: Append failing tests to `test/browser-adapter.test.js`**

```js
const { makeIntentLock } = require("../shared/harness-contracts");

test("BrowserAdapter runs a mode-denied action only with an explicit widening grant", async () => {
  let loads = 0;
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async () => { loads += 1; } }) });
  browser.setPermissionMode("observe");
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "planner" } }), { status: "failed", errorCode: "permission_mode_denied" });
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "lease" } }), { status: "failed", errorCode: "permission_mode_denied" });
  await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "lease", leaseId: "l1" } });
  assert.equal(loads, 1);
});

test("BrowserAdapter refuses lock-denied navigation even when widened or in full mode", async () => {
  let loads = 0;
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async () => { loads += 1; } }), permissionMode: "full" });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "allow_origins", origins: ["https://github.com"] }] }));
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://evil.test/" }, { widenedBy: { kind: "user_once" } }), { status: "failed", errorCode: "intent_lock_denied" });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_action", action: "follow_link" }] }));
  assert.deepEqual(await browser.execute({ type: "follow_link", elementId: "0" }), { status: "failed", errorCode: "intent_lock_denied" });
  assert.equal(loads, 0);
});

test("BrowserAdapter blocks page-initiated navigation to an origin the lock forbids", () => {
  const handlers = {};
  const view = makeFakeView();
  view.webContents.on = (name, fn) => { handlers[name] = fn; };
  const browser = new BrowserAdapter({ view });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_origins", origins: ["https://evil.test"] }] }));
  let prevented = 0;
  handlers["will-redirect"]({ preventDefault: () => { prevented += 1; } }, "https://evil.test/x");
  handlers["will-navigate"]({ preventDefault: () => { prevented += 1; } }, "https://fine.test/");
  assert.equal(prevented, 1);
});

test("supportsAction reports what execute can really do", () => {
  const browser = new BrowserAdapter({ view: makeFakeView() });
  assert.equal(browser.supportsAction("navigate"), true);
  assert.equal(browser.supportsAction("click"), false);
});
```

- [ ] **Step 2:** `node --test test/browser-adapter.test.js` → FAIL (`setIntentLock is not a function`).

- [ ] **Step 3: Implement**

Add near the other requires: `const { evaluateLock } = require("../../shared/harness-contracts");`

In the constructor, set `this._intentLock = null;` next to `this._assignedOrigin`, and replace the `if (this._assignedOrigin) { ... }` listener block with an unconditional guard:

```js
    // Page-initiated navigation (location changes, meta-refresh, server
    // redirects) never passes through execute(), so both the child-agent
    // origin pin and the user's Intent Lock are enforced here as well.
    const rejectIfBlocked = (event, url) => {
      let origin;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = null;
      }
      if (this._assignedOrigin && origin !== this._assignedOrigin) { event.preventDefault(); return; }
      if (!evaluateLock(this._intentLock, { action: "navigate", targetOrigin: origin }).allowed) event.preventDefault();
    };
    listen("will-navigate", rejectIfBlocked);
    listen("will-redirect", rejectIfBlocked);
```

After `setPermissionMode`:

```js
  setIntentLock(lock) {
    this._intentLock = lock ?? null;
  }

  supportsAction(type) {
    return SUPPORTED_ACTIONS.has(type);
  }
```

Change `execute`'s signature to `async execute(action, { signal, documentEpoch, widenedBy } = {})` and replace the permission check with:

```js
    if (!evaluateLock(this._intentLock, { action: action.type }).allowed) {
      return { status: "failed", errorCode: "intent_lock_denied" };
    }
    // A mode-denied action runs only when the task controller passes the
    // grant the user gave (Allow once on a widened request, or a lease).
    const widened = !!widenedBy && (widenedBy.kind === "user_once" || (widenedBy.kind === "lease" && typeof widenedBy.leaseId === "string" && widenedBy.leaseId.length > 0));
    if (!evaluateActionPolicy(this._permissionMode, action.type).allowed && !widened) {
      return { status: "failed", errorCode: "permission_mode_denied" };
    }
```

In `_navigate`, right after the protocol/credential check:

```js
    if (!evaluateLock(this._intentLock, { action: "navigate", targetOrigin: parsed.origin }).allowed) {
      return { status: "failed", errorCode: "intent_lock_denied" };
    }
```

(`_followLink` funnels into `_navigate`, so a link to a forbidden origin is refused there too.)

- [ ] **Step 4:** `node --test test/browser-adapter.test.js test/agent-viewport-host.test.js test/child-agent-coordinator.test.js` → PASS (the assigned-origin behaviour is unchanged).

- [ ] **Step 5: Commit (only after the user asks)** — `git commit -m "Enforce the Intent Lock in the browser adapter"`.

---

### Task 5: TaskController — gate, widened approvals, lend, revoke

**Files:**
- Modify: `apps/computer-browser/main/harness/task-controller.js`
  - constructor (~L311-317): `this._leases = []`, `this._browser.setIntentLock?.(goal.lock ?? null)`
  - `getSnapshot` (~L465): add `leases`, and `widen`/`leaseOffer` on queue items
  - `_amend` (~L957): revoke leases, push the new lock to the browser
  - per-action loop (~L1826-1880): use `evaluateGate`
  - `approve` (~L1045-1077): pass `widenedBy`
  - `_dispatchApprovedAndApplyTracked` (L673) and `_dispatchApproved` (L2003): thread `widenedBy` to `this._browser.execute`
  - new `lend`, `revokeLease`, `_useLease`
- Test: `apps/computer-browser/test/task-controller-lease.test.js` (new)

**Interfaces:**
- Consumes: `evaluateGate`, `actionTargetOrigin` (Task 3); `lendTerms`, `createLease`, `isLeaseLive`, `LeaseError` (Task 3); `widenedBy` on `execute` (Task 4); `lease_*` events (Task 2).
- Produces on `TaskController`:
  - `lend(requestId: string, terms?: { minutes?: number; uses?: number }): Promise<Snapshot>` — grants a lease from the queued item's `leaseOffer` and approves the item using it. Throws `TaskControllerError("lease_unavailable")` when the item is missing, an MCP item, a batch, or has no offer; `TaskControllerError("invalid_lease_terms")` on bad terms.
  - `revokeLease(leaseId: string): Promise<Snapshot>`
  - Snapshot: `leases: { id, action, origin, expiresAt, usesLeft }[]` (live only, empty once stopped/completed); each `approvalQueue[]` item adds `widen: boolean` and `leaseOffer: { action, origin } | null`.

- [ ] **Step 1: Write the failing test** — `test/task-controller-lease.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");

async function makeStore(extra = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-lease-"));
  return TaskStore.create({ originalRequest: "goal", ...extra }, { storageRoot });
}

// Proposes each batch in turn, then finishes.
function plannerFor(...batches) {
  let calls = 0;
  return {
    next: async (context) => {
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [] };
      const actions = batches[calls];
      calls += 1;
      return actions ? { ...base, kind: "actions", actions } : { ...base, kind: "finish", evidenceIds: [] };
    },
  };
}

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    lock: undefined,
    setIntentLock(lock) { this.lock = lock; },
    supportsAction: (type) => ["navigate", "follow_link", "scroll", "observe"].includes(type),
    observe: async () => ({ id: "obs", url: "https://page.test/", elements: [] }),
    execute: async (action, opts = {}) => { calls.push({ type: action.type, widenedBy: opts.widenedBy ?? null }); return { status: "ok" }; },
  };
}

const allow = async () => ({ decision: "allow", reasons: [] });
const deny = async () => ({ decision: "deny", reasons: ["approver said no"] });
const go = (url = "https://github.com/a") => ({ type: "navigate", url });
const clockAt = (t) => { const c = { t, now: () => c.t }; return c; };

test("a lock-denied action is journaled and never reaches the approver or the browser", async () => {
  const store = await makeStore({ lock: { rules: [{ kind: "deny_action", action: "navigate" }] } });
  let approverCalls = 0;
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: async () => { approverCalls += 1; return { decision: "allow", reasons: [] }; }, hostVerifier: () => true, permissionMode: "full" });
  assert.equal(browser.lock.rules[0].action, "navigate", "the controller hands the lock to the browser");
  await controller.start();
  assert.equal(approverCalls, 0);
  assert.deepEqual(browser.calls, []);
  const notes = (await store.getEvents()).filter((e) => e.type === "note" && e.payload.kind === "lock_denied");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].payload.reason, "lock_action_denied");
  await store.close();
});

test("a mode-denied action still asks the approver, then waits for the user as a widened request", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.equal(item.widen, true);
  assert.deepEqual(item.leaseOffer, { action: "navigate", origin: "https://github.com" });
  await controller.approve(item.id);
  assert.deepEqual(browser.calls, [{ type: "navigate", widenedBy: { kind: "user_once" } }]);
  await store.close();
});

test("the approver's deny is never widened or leased", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: deny, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  assert.deepEqual(controller.getSnapshot().approvalQueue, []);
  assert.deepEqual(browser.calls, []);
  await store.close();
});

test("unsupported and unattended mode-denied actions are skipped as before", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const click = { type: "click", elementId: "1" };
  const controller = new TaskController({ store, planner: plannerFor([click]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  assert.deepEqual(controller.getSnapshot().approvalQueue, []);
  const store2 = await makeStore();
  const unattended = new TaskController({ store: store2, planner: plannerFor([go()]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe", reviewFallback: "deny" });
  await unattended.start();
  assert.deepEqual(unattended.getSnapshot().approvalQueue, []);
  await store.close();
  await store2.close();
});

test("Lend approves the request and covers the next matching actions until its uses run out", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const clock = clockAt(1_000_000);
  const controller = new TaskController({ store, planner: plannerFor([go("https://github.com/1")], [go("https://github.com/2")], [go("https://github.com/3")]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe", now: clock.now });
  await controller.start();
  const [first] = controller.getSnapshot().approvalQueue;
  await controller.lend(first.id, { minutes: 5, uses: 2 });
  // uses: 1 for the lent request, 1 for the next proposal; the third waits for the user again.
  assert.equal(browser.calls.length, 2);
  assert.ok(browser.calls.every((c) => c.widenedBy.kind === "lease"));
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.deepEqual(controller.getSnapshot().leases, []);
  const types = (await store.getEvents()).map((e) => e.type).filter((t) => t.startsWith("lease_"));
  assert.deepEqual(types, ["lease_granted", "lease_used", "lease_used"]);
  await store.close();
});

test("a lease that expires while the approver thinks never runs the action", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const clock = clockAt(1_000_000);
  // Each approver call takes 61 s of controller time; the lease lasts 1 min.
  const slowAllow = async () => { clock.t += 61_000; return { decision: "allow", reasons: [] }; };
  const controller = new TaskController({ store, planner: plannerFor([go()], [go()]), browser, approve: slowAllow, hostVerifier: () => true, permissionMode: "observe", now: clock.now });
  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id, { minutes: 1, uses: 3 });
  assert.equal(browser.calls.length, 1, "only the lent request ran");
  assert.equal(controller.getSnapshot().state, "awaiting_approval", "the second action waits for the user");
  assert.deepEqual(controller.getSnapshot().leases, []);
  const used = (await store.getEvents()).filter((e) => e.type === "lease_used");
  assert.equal(used.length, 1);
  await store.close();
});

test("lend rejects bad terms and items without an offer; revoke and amend end leases", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  // The second proposal targets another origin, so the task stays open (awaiting the user) after the lent one runs.
  const controller = new TaskController({ store, planner: plannerFor([go()], [go("https://other.test/")]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;
  await assert.rejects(controller.lend(item.id, { minutes: 30 }), (e) => e instanceof TaskControllerError && e.code === "invalid_lease_terms");
  await assert.rejects(controller.lend("nope"), (e) => e instanceof TaskControllerError && e.code === "lease_unavailable");
  await controller.lend(item.id, { minutes: 10, uses: 3 });
  const [lease] = controller.getSnapshot().leases;
  assert.equal(lease.usesLeft, 2);
  await controller.revokeLease(lease.id);
  assert.deepEqual(controller.getSnapshot().leases, []);
  await store.close();

  const store2 = await makeStore();
  const ctl2 = new TaskController({ store: store2, planner: plannerFor([go()], [go("https://other.test/")]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await ctl2.start();
  await ctl2.lend(ctl2.getSnapshot().approvalQueue[0].id);
  assert.equal(ctl2.getSnapshot().leases.length, 1);
  await ctl2.amend({ text: "change of plan" });
  assert.deepEqual(ctl2.getSnapshot().leases, []);
  const revoked = (await store2.getEvents()).filter((e) => e.type === "lease_revoked");
  assert.equal(revoked[0].payload.reason, "goal_amended");
  await store2.close();
});
```


- [ ] **Step 2:** `node --test test/task-controller-lease.test.js` → FAIL (`lend is not a function`, no `widen` field).

- [ ] **Step 3: Implement**

Requires at the top of `task-controller.js`:

```js
const { evaluateGate, actionTargetOrigin } = require("./action-gate");
const { lendTerms, createLease, isLeaseLive, LeaseError } = require("./capability-lease");
```

Constructor, right after `this._browser.setPermissionMode?.(permissionMode);`:

```js
    // Leases live only as long as this controller: a restarted task starts
    // with none, which is stricter than replaying them from the journal.
    this._leases = [];
    this._browser.setIntentLock?.(this._goal.lock ?? null);
```

(If `this._goal` is assigned after this point, move these two lines below the goal assignment.)

`getSnapshot` — replace the `approvalQueue` line and add `leases`:

```js
      approvalQueue: this._approvalQueue.map(({ id, summary, actionType, createdAt, descriptor, widen, leaseOffer }) => ({ id, summary, action: actionType, createdAt, target: descriptor?.target ?? null, widen: !!widen, leaseOffer: leaseOffer ?? null })),
      leases: ["stopped", "completed"].includes(this._task.state) ? [] : this._leases.filter((l) => isLeaseLive(l, this._now())).map(({ id, action, origin, expiresAt, usesLeft }) => ({ id, action, origin, expiresAt, usesLeft })),
```

`_amend`, right after `this._goal = nextGoal;`:

```js
    this._browser.setIntentLock?.(nextGoal.lock ?? null);
    // The intent changed, so every lent permission is taken back.
    for (const lease of this._leases.filter((l) => isLeaseLive(l, this._now()))) {
      lease.revoked = true;
      await this._store.append({ type: "lease_revoked", payload: { leaseId: lease.id, reason: "goal_amended" } });
    }
```

Per-action loop — replace from `let decision;` through the `if (decision.decision === "review") {` push block's opening so that it reads:

```js
      let decision;
      const targetOrigin = actionTargetOrigin(action, this._lastObservation);
      const gate = evaluateGate({ lock: this._goal.lock ?? null, mode: this._permissionMode, leases: this._leases, action: action.type, targetOrigin, now: this._now() });
      if (gate.outcome === "lock_denied") {
        await this._store.append({ type: "note", payload: { kind: "lock_denied", actionType: action.type, reason: gate.reason, ruleIndex: gate.ruleIndex } });
        if (this._routineRunner) {
          await this._denyRoutineStep({ decision: "deny", reasons: [gate.reason] });
          return "stop_loop";
        }
        continue;
      }
      const policy = gate.policy;
      // Mode-denied actions may be widened by the user, but never for
      // unattended runs or for actions this browser cannot perform.
      const widen = !policy.allowed;
      if (widen && (this._routineRunner || this._reviewFallback === "deny" || this._browser.supportsAction?.(action.type) === false || policy.reason === "unsupported_action")) {
        if (this._routineRunner) {
          await this._denyRoutineStep({ decision: "deny", reasons: [policy.reason || "permission_mode_denied"] });
          return "stop_loop";
        }
        continue;
      }
      try {
        decision = widen
          ? await this._approve(descriptor)
          : policy.approval === "bypass"
            ? { decision: "allow", reasons: ["explicit_full_permission"] }
            : policy.approval === "human"
              ? { decision: "review", reasons: ["human_confirmation_required"] }
              : await this._approve(descriptor);
      } catch {
        if (this._stopHappenedSince(epoch)) return "stop_loop";
        await this._pauseWith("approver_error");
        return "stop_loop";
      }
      if (this._stopHappenedSince(epoch)) return "stop_loop";
      // The approver's allow does not lift the mode; the user still decides.
      if (widen && decision.decision === "allow") decision = { decision: "review", reasons: [...(decision.reasons || []), "permission_mode_denied"] };
      let widenedBy = null;
      // The approver may have taken time: re-check the lease at use time. A
      // lease that died meanwhile leaves the request for the user.
      if (decision.decision === "review" && gate.lease) {
        widenedBy = await this._useLease(gate.lease, requestId);
        if (widenedBy) decision = { decision: "allow", reasons: ["capability_lease"] };
      }
      decision = await this._applyReviewFallback(decision, action.type);

      if (decision.decision === "review") {
        this._approvalQueue.push({
          id: requestId,
          summary: descriptor.summary,
          actionType: action.type,
          createdAt: new Date().toISOString(),
          epoch,
          goalVersion: this._goal.goalVersion,
          expiresAt: this._now() + contracts.APPROVAL_EXPIRY_MS,
          descriptor,
          action,
          proposal,
          widen,
          leaseOffer: targetOrigin && LEASE_ACTIONS.includes(action.type) ? { action: action.type, origin: targetOrigin } : null,
        });
```

(keep the existing approval-binding comment and the rest of the block unchanged; add `LEASE_ACTIONS` to the `capability-lease` require.) Then, where the loop later dispatches an allowed action (L1882), pass the grant:

```js
      const dispatched = await this._dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch, { widenedBy });
```

Thread it through:

```js
  async _dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch, { durable = true, widenedBy = null } = {}) {
    const op = (async () => {
      const result = await this._dispatchApproved(descriptor, action, epoch, { durable, widenedBy });
```

```js
  async _dispatchApproved(descriptor, action, epoch, { durable = true, widenedBy = null } = {}) {
    ...
      result = await this._browser.execute(action, { signal: undefined, documentEpoch, widenedBy });
```

`approve` — in the single-action branch replace the dispatch line with:

```js
      // The user clicked for this very request, so a widened item runs once
      // even if the lease they just lent were somehow no longer live.
      const leased = item.useLease ? await this._useLease(this._leases.find((l) => l.id === item.useLease), item.id) : null;
      const widenedBy = leased ?? (item.widen ? { kind: "user_once" } : null);
      const dispatched = await this._dispatchApprovedAndApplyTracked(item.proposal, item.descriptor, item.action, epoch, { widenedBy });
```

New methods (place after `deny`):

```js
  // Lend: the user turns one queued request into a short, scoped lease. The
  // request itself is approved and counts as the lease's first use.
  async lend(requestId, terms) {
    this._checkAdmission();
    const item = this._approvalQueue.find((q) => q.id === requestId);
    if (!item || isMcpItem(item) || item.actions || !item.leaseOffer) {
      throw new TaskControllerError("lease_unavailable", "this request cannot be lent as a lease");
    }
    let parsed;
    try {
      parsed = lendTerms(terms);
    } catch (error) {
      if (error instanceof LeaseError) throw new TaskControllerError(error.code, error.message);
      throw error;
    }
    if (!this._stopHappenedSince(item.epoch) && this._now() < item.expiresAt) {
      const lease = createLease({ id: randomUUID(), taskId: this._goal.taskId, action: item.leaseOffer.action, origin: item.leaseOffer.origin, now: this._now(), ...parsed });
      await this._store.append({ type: "lease_granted", payload: { leaseId: lease.id, action: lease.action, origin: lease.origin, expiresAt: lease.expiresAt, uses: parsed.uses } });
      this._leases.push(lease);
      item.useLease = lease.id;
    }
    return this.approve(requestId);
  }

  async revokeLease(leaseId) {
    const lease = this._leases.find((l) => l.id === leaseId);
    if (lease && !lease.revoked) {
      lease.revoked = true;
      await this._store.append({ type: "lease_revoked", payload: { leaseId, reason: "user" } });
      this._emit();
    }
    return this.getSnapshot();
  }

  // The use is journaled durably BEFORE the action runs: a crash mid-action
  // can never hand the use back.
  async _useLease(lease, requestId) {
    if (!lease || !isLeaseLive(lease, this._now())) return null;
    await this._store.append({ type: "lease_used", payload: { leaseId: lease.id, requestId } });
    lease.usesLeft -= 1;
    return { kind: "lease", leaseId: lease.id };
  }
```

`_useLease` returns `null` for a dead lease. Only the `approve` path (the user just clicked for this exact request) falls back to `user_once`; the loop path leaves the request in the queue.

- [ ] **Step 4:** `node --test test/task-controller-lease.test.js test/task-controller.test.js test/task-controller-review-fallback.test.js test/task-controller-mcp.test.js test/routine-runner.test.js test/routine-task-e2e.test.js` → PASS.

If an existing test expected observe-mode `navigate` to be silently skipped, it now becomes a widened approval: update that test's expectation only if it is about interactive runs; routine/unattended tests must keep passing unchanged.

- [ ] **Step 5: Commit (only after the user asks)** — `git commit -m "Gate planner actions by lock, mode and lease; add Lend"`.

---

### Task 6: Host, IPC and preload

**Files:**
- Modify: `apps/computer-browser/main/harness/task-host.js` (next to `approveTask` ~L1596)
- Modify: `apps/computer-browser/main/ipc.js` (`HARNESS_METHODS`)
- Modify: `apps/computer-browser/preload/index.js` (`HARNESS_METHODS`)
- Test: `apps/computer-browser/test/harness-ipc.test.js`, `test/preload-api.test.js` (extend the existing channel tables)

**Interfaces:**
- `TaskHost.lendTask(taskId, requestId, terms)`, `TaskHost.revokeTaskLease(taskId, leaseId)` → snapshot
- IPC `halo:taskLend` → `lendTask`, `halo:taskRevokeLease` → `revokeTaskLease`
- Preload `window.haloBrowser.taskLend(taskId, requestId, terms)`, `taskRevokeLease(taskId, leaseId)`

- [ ] **Step 1: Failing tests** — in `test/harness-ipc.test.js`, add to the trusted-sender table next to `["halo:taskApprove", ["task-1", "req-1"]]`:

```js
    ["halo:taskLend", ["task-1", "req-1", { minutes: 5, uses: 1 }]],
    ["halo:taskRevokeLease", ["task-1", "lease-1"]],
```

and give the fake task host used there `lendTask` / `revokeTaskLease` methods that record their arguments, mirroring how `approveTask` is faked in that file. In `test/preload-api.test.js` add `"taskLend", "taskRevokeLease"` wherever the expected harness method list is asserted.

- [ ] **Step 2:** `node --test test/harness-ipc.test.js test/preload-api.test.js` → FAIL.

- [ ] **Step 3: Implement**

`task-host.js`:

```js
  async lendTask(taskId, requestId, terms) {
    const { controller } = this._require(taskId);
    return controller.lend(requestId, terms);
  }

  async revokeTaskLease(taskId, leaseId) {
    const { controller } = this._require(taskId);
    return controller.revokeLease(leaseId);
  }
```

`ipc.js` `HARNESS_METHODS`: add `"halo:taskLend": "lendTask",` and `"halo:taskRevokeLease": "revokeTaskLease",` after `"halo:taskDeny"`.

`preload/index.js` `HARNESS_METHODS`: add `"taskLend", "taskRevokeLease"` after `"taskDeny"`.

Lock writes need no new channel: `createTask(goalInput)` and `amendTask(taskId, amendment)` already carry `lock` through the validated contract, and no planner/MCP/room code path builds a goal input with `lock`. Add this guard test to `test/intent-lock.test.js`:

```js
test("no planner, room or MCP module writes a lock", async () => {
  const dir = path.join(__dirname, "../main/harness");
  for (const file of ["planner-command.js", "room-orchestrator.js", "generic-mcp-broker.js", "child-agent-coordinator.js", "agent-service.js"]) {
    const source = await fs.readFile(path.join(dir, file), "utf8");
    assert.doesNotMatch(source, /\block\s*:/, `${file} must not set a goal lock`);
  }
});
```

(If any of those files legitimately uses a `lock:` key for something else, e.g. a mutex, narrow the regex to `/\block\s*:\s*\{\s*rules/` and say so in the commit message.)

- [ ] **Step 4:** `node --test test/harness-ipc.test.js test/preload-api.test.js test/intent-lock.test.js test/task-host.test.js` → PASS.

- [ ] **Step 5: Commit (only after the user asks)** — `git commit -m "Expose Lend and lease revoke over IPC"`.

---

### Task 7: Frontend — Lend on the approval sheet, lease chip, lock chips

**Files:**
- Modify: `frontend/src/session/api.ts`, `frontend/src/session/types.ts`, `frontend/src/session/session.ts`
- Modify: `frontend/src/components/HaloSheet.tsx`
- Create: `frontend/src/components/LeaseChip.tsx`, `frontend/src/components/LockChips.tsx`
- Modify: `frontend/src/components/HomeScreen.tsx`, `frontend/src/components/Viewport.tsx`, `frontend/src/App.tsx`
- Modify: `frontend/src/styles/app.css` (append a small block, tokens only)
- Test: `frontend/test/lease-ui.test.mjs` (new)

**Interfaces:**
- `api.ts`: `LockRule`, `IntentLockInput = { rules: LockRule[] }`; `GoalInput.lock?: IntentLockInput`; `GoalSpec.lock?: { rules: LockRule[]; digest: string }`; `ApprovalRequest` gains `widen?: boolean; leaseOffer?: { action: string; origin: string } | null`; `TaskSnapshot.leases?: LeaseView[]` with `LeaseView = { id; action; origin; expiresAt; usesLeft }`; `HaloBrowserApi.taskLend(taskId, requestId, terms)`, `taskRevokeLease(taskId, leaseId)`.
- `types.ts` `Approval` gains `widen: boolean; leaseOffer: { action: string; origin: string } | null`.
- `session.ts`: `sendMessage(text, lock?)`; `lend(approval, terms)`; `revokeLease(leaseId)`.
- `HaloSheet` new prop `onLend?: (terms: { minutes: number; uses: number }) => void`.
- `LeaseChip({ leases, now, agent, onRevoke })`, `LockChips({ value, onChange })`, `lockFromChips(chips, origin?)`.

- [ ] **Step 1: Write the failing test** — `frontend/test/lease-ui.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { HaloSheet, lendSummary } = await vite.ssrLoadModule('/src/components/HaloSheet.tsx')
const { LeaseChip, leaseLabel } = await vite.ssrLoadModule('/src/components/LeaseChip.tsx')
const { LockChips, lockFromChips } = await vite.ssrLoadModule('/src/components/LockChips.tsx')
test.after(() => vite.close())
const noop = () => {}

const approval = { taskId: 't', id: 'r', action: 'Open github.com', request: 'navigate', createdAt: 'now', widen: true, leaseOffer: { action: 'navigate', origin: 'https://github.com' } }

test('the sheet offers Lend only when the request has a lease offer, and says when the mode is widened', () => {
  const html = renderToStaticMarkup(React.createElement(HaloSheet, { approval, onApprove: noop, onDeny: noop, onTakeOver: noop, onLend: noop }))
  assert.match(html, />Lend…</)
  assert.match(html, /outside the current permission mode/)
  const plain = renderToStaticMarkup(React.createElement(HaloSheet, { approval: { ...approval, widen: false, leaseOffer: null }, onApprove: noop, onDeny: noop, onTakeOver: noop, onLend: noop }))
  assert.doesNotMatch(plain, /Lend…/)
})

test('lend terms read as one line and can only shrink', () => {
  assert.equal(lendSummary(approval.leaseOffer, { minutes: 10, uses: 3 }), 'navigate · github.com · 10 min · 3 uses')
  assert.equal(lendSummary(approval.leaseOffer, { minutes: 1, uses: 1 }), 'navigate · github.com · 1 min · 1 use')
})

test('the lease chip shows who borrowed what for how long, and revokes', () => {
  const leases = [{ id: 'l1', action: 'navigate', origin: 'https://github.com', expiresAt: 600_000, usesLeft: 2 }]
  assert.equal(leaseLabel('Atlas', leases[0], 120_000), 'Atlas borrowed: navigate · github.com · 8 min · 2 left')
  const html = renderToStaticMarkup(React.createElement(LeaseChip, { leases, now: 120_000, agent: 'Atlas', onRevoke: noop }))
  assert.match(html, /aria-label="Revoke lease navigate on github.com"/)
  assert.equal(renderToStaticMarkup(React.createElement(LeaseChip, { leases: [], now: 0, agent: 'Atlas', onRevoke: noop })), '')
})

test('lock chips turn into host rules; enforced rules are marked as such', () => {
  assert.deepEqual(lockFromChips(new Set()), undefined)
  assert.deepEqual(lockFromChips(new Set(['no_links'])), { rules: [{ kind: 'deny_action', action: 'follow_link' }] })
  assert.deepEqual(lockFromChips(new Set(['this_site']), 'https://github.com/x'), { rules: [{ kind: 'allow_origins', origins: ['https://github.com'] }] })
  assert.equal(lockFromChips(new Set(['this_site'])), undefined, 'no site to pin without a page')
  const html = renderToStaticMarkup(React.createElement(LockChips, { value: new Set(['no_links']), onChange: noop }))
  assert.match(html, /aria-pressed="true"[^>]*>[^<]*Don’t follow links/)
  assert.match(html, /Enforced by Halo/)
})
```

- [ ] **Step 2:** `cd frontend && node --experimental-strip-types --test test/lease-ui.test.mjs` → FAIL (exports missing).

- [ ] **Step 3: Implement**

`session/api.ts` (add types and fields named in Interfaces; add to the `HaloBrowserApi` interface):

```ts
export type LockRule = { kind: 'deny_action'; action: 'navigate' | 'follow_link' | 'click' | 'type' | 'submit_form' } | { kind: 'allow_origins' | 'deny_origins'; origins: string[] }
export interface IntentLockInput { rules: LockRule[] }
export interface LeaseOffer { action: string; origin: string }
export interface LeaseView { id: string; action: string; origin: string; expiresAt: number; usesLeft: number }
// ApprovalRequest: add `widen?: boolean; leaseOffer?: LeaseOffer | null`
// TaskSnapshot: add `leases?: LeaseView[]`
// GoalInput: add `lock?: IntentLockInput`; GoalSpec: add `lock?: { rules: LockRule[]; digest: string }`
// HaloBrowserApi:
//   taskLend(taskId: string, requestId: string, terms: { minutes: number; uses: number }): Promise<TaskSnapshot>
//   taskRevokeLease(taskId: string, leaseId: string): Promise<TaskSnapshot>
```

`session/types.ts` `Approval`: add `widen: boolean; leaseOffer: { action: string; origin: string } | null`. In `session.ts` where `approval:` is derived (L51), add `widen: !!head.widen, leaseOffer: head.leaseOffer ?? null`.

`session.ts`:

```ts
  async sendMessage(text: string, lock?: IntentLockInput) {
    // ...unchanged until the create call:
      const result = await this.api.createTask(lock ? { originalRequest: text, lock } : { originalRequest: text })
  }
  lend(approval: Approval, terms: { minutes: number; uses: number }) {
    if (approval.taskId !== this.state.activeTaskId || approval.id !== this.state.approval?.id || !approval.leaseOffer) return Promise.resolve(false)
    return this.runCommand('approve', () => this.api!.taskLend(approval.taskId, approval.id, terms))
  }
  revokeLease(leaseId: string) {
    const taskId = this.state.activeTaskId
    if (!taskId) return Promise.resolve(false)
    return this.runCommand('approve', () => this.api!.taskRevokeLease(taskId, leaseId))
  }
```

(Keep `sendMessage`'s amend branch unchanged: a lock is only set at creation from the composer.)

`components/HaloSheet.tsx`:

```tsx
const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
export const lendSummary = (offer: { action: string; origin: string }, t: { minutes: number; uses: number }) =>
  `${offer.action} · ${host(offer.origin)} · ${t.minutes} min · ${t.uses} ${t.uses === 1 ? 'use' : 'uses'}`

// Props: add `onLend?: (terms: { minutes: number; uses: number }) => void`
export function HaloSheet({ approval, leaving, onApprove, onDeny, onTakeOver, onLend }: Props) {
  const ref = useRef<HTMLHeadingElement>(null)
  const [lending, setLending] = useState(false)
  const [terms, setTerms] = useState({ minutes: 10, uses: 3 })
  useEffect(() => { ref.current?.focus(); setLending(false); setTerms({ minutes: 10, uses: 3 }) }, [approval])
  const offer = approval.leaseOffer
  return (
    <section className="hx-sheet" data-approval-id={approval.id} data-leaving={leaving || undefined} inert={leaving} role="alertdialog" aria-modal="true" aria-labelledby="hx-sheet-title" aria-describedby="hx-sheet-request">
      <p className="hx-sheet__from"><HaloMark className="hx-sheet__mark" />Halo paused {AGENT} for your approval</p>
      <h2 className="hx-sheet__title" id="hx-sheet-title" tabIndex={-1} ref={ref}>{approval.action}</h2>
      {approval.widen && <p className="hx-sheet__widen">This is outside the current permission mode.</p>}
      {lending && offer && (
        <div className="hx-sheet__lend">
          <label>Minutes <input type="range" min={1} max={10} value={terms.minutes} onChange={(e) => setTerms({ ...terms, minutes: Number(e.target.value) })} /></label>
          <label>Uses <input type="range" min={1} max={3} value={terms.uses} onChange={(e) => setTerms({ ...terms, uses: Number(e.target.value) })} /></label>
          <p className="hx-sheet__lend-summary">{lendSummary(offer, terms)}</p>
        </div>
      )}
      <div className="hx-sheet__actions">
        <button className="hx-sheet__takeover" onClick={onTakeOver}>Take over</button>
        <button className="hx-btn hx-btn--secondary" onClick={onDeny}>Deny</button>
        {offer && onLend && (lending
          ? <button className="hx-btn hx-btn--secondary" onClick={() => onLend(terms)}>Lend</button>
          : <button className="hx-btn hx-btn--secondary" onClick={() => setLending(true)}>Lend…</button>)}
        <button className="hx-btn hx-btn--primary" onClick={onApprove}>Allow once</button>
      </div>
      <code className="hx-sheet__request" id="hx-sheet-request" title="Exact request">{approval.request}</code>
    </section>
  )
}
```

(import `useState`; keep the existing focus comment.)

`components/LeaseChip.tsx`:

```tsx
import type { LeaseView } from '../session/api'

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }

export function leaseLabel(agent: string, lease: LeaseView, now: number) {
  const minutes = Math.max(1, Math.ceil((lease.expiresAt - now) / 60_000))
  return `${agent} borrowed: ${lease.action} · ${host(lease.origin)} · ${minutes} min · ${lease.usesLeft} left`
}

/** Live leases for the active task; clicking one takes it back. */
export function LeaseChip({ leases, now, agent, onRevoke }: { leases: LeaseView[]; now: number; agent: string; onRevoke: (id: string) => void }) {
  if (!leases.length) return null
  return (
    <div className="hx-leases" role="status">
      {leases.map((l) => (
        <button key={l.id} type="button" className="hx-lease" aria-label={`Revoke lease ${l.action} on ${host(l.origin)}`} onClick={() => onRevoke(l.id)}>
          <span className="hx-lease__dot" aria-hidden="true" />{leaseLabel(agent, l, now)}
        </button>
      ))}
    </div>
  )
}
```

`components/LockChips.tsx`:

```tsx
import type { IntentLockInput } from '../session/api'

export type LockChip = 'no_links' | 'no_navigate' | 'this_site'
const CHIPS: { id: LockChip; label: string }[] = [
  { id: 'no_navigate', label: 'Don’t open new pages' },
  { id: 'no_links', label: 'Don’t follow links' },
  { id: 'this_site', label: 'Stay on this site' },
]

/** Host rules for the chosen chips; `this_site` needs the page the task starts from. */
export function lockFromChips(chips: ReadonlySet<LockChip>, pageUrl?: string): IntentLockInput | undefined {
  const rules: IntentLockInput['rules'] = []
  if (chips.has('no_navigate')) rules.push({ kind: 'deny_action', action: 'navigate' })
  if (chips.has('no_links')) rules.push({ kind: 'deny_action', action: 'follow_link' })
  if (chips.has('this_site') && pageUrl) {
    try { rules.push({ kind: 'allow_origins', origins: [new URL(pageUrl).origin] }) } catch { /* no site to pin */ }
  }
  return rules.length ? { rules } : undefined
}

export function LockChips({ value, onChange, pageUrl }: { value: ReadonlySet<LockChip>; onChange: (next: Set<LockChip>) => void; pageUrl?: string }) {
  const toggle = (id: LockChip) => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); onChange(next) }
  return (
    <div className="hx-lockchips" role="group" aria-label="Intent lock">
      <span className="hx-lockchips__label">🔒 Enforced by Halo</span>
      {CHIPS.filter((c) => c.id !== 'this_site' || pageUrl).map((c) => (
        <button key={c.id} type="button" className="hx-lockchip" aria-pressed={value.has(c.id)} onClick={() => toggle(c.id)}>{c.label}</button>
      ))}
    </div>
  )
}
```

Wiring:
- `HomeScreen.tsx`: `const [lockChips, setLockChips] = useState<Set<LockChip>>(new Set())`; render `<LockChips value={lockChips} onChange={setLockChips} />` directly under the `<form>`; change `onSubmit: (text: string, lock?: IntentLockInput) => void` and call `onSubmit(text, lockFromChips(lockChips))`.
- `Viewport.tsx`: `onStartTask: (text: string, lock?: IntentLockInput) => void` (type only; it already forwards the function).
- `App.tsx`: make `onSendMessage` accept `(text, lock?)` and call `store.sendMessage(text, lock)`; pass `onLend={(terms) => void store.lend(sheet.item!, terms)}` to `<HaloSheet>`; render `<LeaseChip leases={s.snapshot?.leases ?? []} now={Date.now()} agent={AGENT} onRevoke={(id) => void store.revokeLease(id)} />` in the task header area next to the existing task status (find the element that renders `controlLabel` and place it beside it). Re-render each minute via the existing clock/tick if one exists; otherwise a `useEffect` interval of 30 s that bumps a state counter while `leases.length > 0`.

`styles/app.css` (append):

```css
/* Intent lock chips and lent capabilities. */
.hx-lockchips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.hx-lockchips__label { color: var(--muted-foreground); font-size: 11px; }
.hx-lockchip { height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 13px; background: var(--surface-2); color: var(--muted-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.hx-lockchip[aria-pressed="true"] { border-color: var(--brand); color: var(--foreground); background: color-mix(in oklab, var(--brand), transparent 88%); }
.hx-sheet__widen { margin: 0 0 8px; color: var(--warning); font-size: 12px; }
.hx-sheet__lend { display: grid; gap: 6px; margin: 0 0 10px; font-size: 12px; }
.hx-sheet__lend-summary { margin: 0; font-family: var(--font-mono); color: var(--muted-foreground); }
.hx-leases { display: flex; gap: 6px; }
.hx-lease { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); color: var(--foreground); font: inherit; font-size: 11.5px; cursor: pointer; }
.hx-lease__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--brand); }
@media (prefers-reduced-motion: no-preference) { .hx-lease__dot { animation: hx-lease-blink 1.6s ease-in-out infinite; } }
@keyframes hx-lease-blink { 50% { opacity: .35; } }
```

- [ ] **Step 4:** `cd frontend && npm test && npx tsc --noEmit -p . && npm run build` → all pass except the pre-existing `profile-import` failure.

- [ ] **Step 5: Commit (only after the user asks)** — `git commit -m "Add Lend, lease chip and lock chips to the UI"` (do not add `renderer/dist`).

---

### Task 8: End-to-end check in the app

**Files:** none (verification only)

- [ ] **Step 1:** `cd apps/computer-browser && npm test` → all pass (note any pre-existing failures verbatim).
- [ ] **Step 2:** Rebuild the frontend (`npm run build` in `frontend`), Force Reload the running app.
- [ ] **Step 3:** In Settings set permission to **Observe**. Start a task with **Stay on this site** off and **Don’t follow links** on: "open github.com and read the trending page".
  - Expect: the navigate appears as a sheet saying it is outside the current permission mode, with **Lend…**.
  - Lend 2 min · 2 uses → the lease chip shows `… borrowed: navigate · github.com · 2 min · 1 left`.
  - A proposed follow_link never reaches the sheet; the activity log shows the lock note.
- [ ] **Step 4:** Click the chip → lease disappears; next navigate asks again.
- [ ] **Step 5:** Screenshot the sheet and the chip and report. Do not click sidebar tasks (it resumes paused tasks).

---

## Self-review notes

- Spec §1 order (lock → mode → lease), §2 rules/digest/user-only writes, §3 lend/consume/expire/revoke, §4 UI, §5 durability, §6 tests are covered by Tasks 1–7; deviations are listed at the top.
- `lease_revoked` reasons are `user | goal_amended`; terminal tasks hide leases in the snapshot and never dispatch again, so no `task_ended` record is written.
- Names used across tasks: `evaluateLock`, `makeIntentLock`, `validateIntentLock`, `lockDigest`, `LOCK_ACTIONS`, `LEASE_ACTIONS`, `lendTerms`, `createLease`, `isLeaseLive`, `findLease`, `evaluateGate`, `actionTargetOrigin`, `setIntentLock`, `supportsAction`, `widenedBy`, `lend`, `revokeLease`, `lendTask`, `revokeTaskLease`, `taskLend`, `taskRevokeLease`.
