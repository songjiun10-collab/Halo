"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { collectEvents, status, setPayments } = require("../tools/halo-admin");

async function dataRoot(journals) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-admin-"));
  for (const [id, lines] of Object.entries(journals)) {
    await fs.mkdir(path.join(root, "tasks", id), { recursive: true });
    await fs.writeFile(path.join(root, "tasks", id, "events.jsonl"), lines.join("\n") + "\n");
  }
  return root;
}
const note = (taskId, at, payload) => JSON.stringify({ seq: 1, taskId, type: "note", at, payload });

test("events lists only safety notes, oldest first, with just the explaining fields", async () => {
  const root = await dataRoot({
    a: [note("a", "2026-10-02T00:00:00Z", { kind: "payment_authorized", origin: "https://shop.example", amountMinor: 1200, currency: "KRW", mandateId: "secret-id" }), note("a", "2026-10-01T00:00:00Z", { kind: "card_input_blocked", tier: 3, actionType: "type" })],
    b: [note("b", "2026-10-03T00:00:00Z", { kind: "research_source", url: "https://x.example" }), "not json"],
  });
  const { events, unreadable } = await collectEvents(root);
  assert.deepEqual(events.map((e) => e.kind), ["card_input_blocked", "payment_authorized"]);
  assert.equal(events[1].detail.mandateId, undefined, "ids and other payload fields stay out");
  assert.equal(events[1].detail.origin, "https://shop.example");
  assert.equal(unreadable, 1, "a broken line is counted, not fatal");
  assert.equal((await collectEvents(root, { since: "2026-10-02" })).events.length, 1);
});

test("a data folder with no tasks is simply empty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-admin-"));
  assert.deepEqual((await collectEvents(root)).events, []);
});

test("payments off writes the settings file and status reads it back; bad words are refused", async () => {
  const root = await dataRoot({});
  assert.deepEqual(await setPayments(root, "on"), { paymentsEnabled: true });
  assert.equal((await status(root)).paymentsEnabled, true);
  assert.deepEqual(await setPayments(root, "off"), { paymentsEnabled: false });
  assert.equal((await status(root)).paymentsEnabled, false);
  await assert.rejects(() => setPayments(root, "maybe"), /on or off/);
});

test("status counts safety events and reports build expiry from a build-info file", async () => {
  const root = await dataRoot({ a: [note("a", "2026-10-01T00:00:00Z", { kind: "payment_question", reason: "which site?" }), note("a", "2026-10-01T00:00:01Z", { kind: "payment_question", reason: "again" })] });
  const info = path.join(root, "build-info.json");
  await fs.writeFile(info, JSON.stringify({ expiresAt: "2000-01-01" }));
  const s = await status(root, info);
  assert.deepEqual(s.safetyCounts, { payment_question: 2 });
  assert.equal(s.build.expired, true);
});
