"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { MessageMailbox } = require("../main/harness/message-mailbox");

const CONVERSATION = "conversation-1";

async function fixture(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-mailbox-"));
  let parent = await TaskStore.create({ originalRequest: "parent" }, { storageRoot });
  let child = await TaskStore.createChild({ originalRequest: "child" }, {
    storageRoot,
    parentTaskId: parent.taskId,
  });
  let stores = new Map([[parent.taskId, parent], [child.taskId, child]]);
  const parentTaskId = parent.taskId;
  const childTaskId = child.taskId;
  const makeMailbox = () => new MessageMailbox({
    getTaskStore: (id) => stores.get(id),
    getConversationTaskIds: (id) => id === CONVERSATION ? { parentTaskId, childTaskId } : null,
  });
  t.after(async () => {
    await Promise.allSettled([...stores.values()].map((store) => store.close()));
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  return {
    get parent() { return parent; },
    get child() { return child; },
    parentTaskId,
    childTaskId,
    makeMailbox,
    async reopen() {
      await Promise.all([parent.close(), child.close()]);
      parent = await TaskStore.load(parentTaskId, { storageRoot });
      child = await TaskStore.loadChild(childTaskId, { storageRoot, parentTaskId });
      stores = new Map([[parentTaskId, parent], [childTaskId, child]]);
    },
  };
}

function envelope(f, key, overrides = {}) {
  return {
    conversationId: CONVERSATION,
    parentTaskId: f.parentTaskId,
    childTaskId: f.childTaskId,
    senderTaskId: f.parentTaskId,
    recipientTaskId: f.childTaskId,
    parentGoalVersion: 1,
    kind: "progress",
    idempotencyKey: key,
    text: `message ${key}`,
    ...overrides,
  };
}

async function allEvents(store) {
  const events = [];
  let since = 0;
  for (;;) {
    const page = await store.getEvents({ since });
    if (page.length === 0) return events;
    events.push(...page);
    since = page.at(-1).seq;
  }
}

test("send persists only in sender journal; one consumed batch removes pending IDs", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  const first = await mailbox.send(envelope(f, "one"));
  const second = await mailbox.send(envelope(f, "two"));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.notEqual(first.messageId, second.messageId);
  assert.deepEqual((await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }))
    .map((m) => m.messageId), [first.messageId, second.messageId]);
  assert.equal((await allEvents(f.child)).filter((e) => e.type === "message_sent").length, 0);

  const consumed = await mailbox.recordConsumed(f.childTaskId, [first.messageId, second.messageId], 7);
  assert.equal(consumed.type, "message_turn_consumed");
  assert.deepEqual(consumed.payload, {
    consumedMessageIds: [first.messageId, second.messageId], observedAtPlannerCall: 7,
  });
  assert.equal((await allEvents(f.child)).filter((e) => e.type === "message_turn_consumed").length, 1);
  assert.deepEqual(await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }), []);
  assert.equal(await mailbox.recordConsumed(f.childTaskId, []), null);
});

test("same-key retries return the original ID, including after restart; changed payload conflicts", async (t) => {
  const f = await fixture(t);
  let mailbox = f.makeMailbox();
  const original = envelope(f, "retry", { evidenceRefs: ["evidence-1"] });
  const first = await mailbox.send(original);
  const repeated = await mailbox.send({ ...original, evidenceRefs: ["evidence-1"] });
  assert.deepEqual(repeated, { messageId: first.messageId, duplicate: true });
  await assert.rejects(() => mailbox.send({ ...original, text: "changed" }), (e) => e.code === "idempotency_conflict");
  await assert.rejects(() => mailbox.send({ ...original, recipientTaskId: f.parentTaskId }),
    (e) => e.code === "idempotency_conflict");
  await f.reopen();
  mailbox = f.makeMailbox();
  assert.deepEqual(await mailbox.send(original), { messageId: first.messageId, duplicate: true });
  assert.equal((await allEvents(f.parent)).filter((e) => e.type === "message_sent").length, 1);
  assert.deepEqual((await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }))
    .map((m) => m.messageId), [first.messageId]);
});

test("concurrent same-key sends serialize to one durable event", async (t) => {
  const f = await fixture(t);
  const mailboxes = [f.makeMailbox(), f.makeMailbox()];
  const request = envelope(f, "racing");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => mailboxes[i % 2].send(request)));
  assert.equal(new Set(results.map((result) => result.messageId)).size, 1);
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal((await allEvents(f.parent)).filter((e) => e.type === "message_sent").length, 1);
});

test("failed durable append leaves no phantom idempotency or pending state", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  const originalAppend = f.parent.append.bind(f.parent);
  let failOnce = true;
  f.parent.append = async (...args) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error("injected"), { code: "journal_write_failed" }); }
    return originalAppend(...args);
  };
  const request = envelope(f, "after-failure");
  await assert.rejects(() => mailbox.send(request), (e) => e.code === "journal_write_failed");
  assert.deepEqual(await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }), []);
  const accepted = await mailbox.send(request);
  assert.equal(accepted.duplicate, false);
  assert.equal((await allEvents(f.parent)).filter((e) => e.type === "message_sent").length, 1);
});

test("same-payload retry succeeds at quota while a new key is rejected", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  const first = await mailbox.send(envelope(f, "first"));
  for (let i = 1; i < 50; i += 1) await mailbox.send(envelope(f, `full-${i}`));
  assert.deepEqual(await mailbox.send(envelope(f, "first")), {
    messageId: first.messageId, duplicate: true,
  });
  await assert.rejects(() => mailbox.send(envelope(f, "overflow")), (e) => e.code === "queue_full");
  assert.equal((await allEvents(f.parent)).filter((e) => e.type === "message_sent").length, 50);
});

test("failed consumed append leaves messages pending for redelivery", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  const sent = await mailbox.send(envelope(f, "observe-later"));
  const originalAppend = f.child.append.bind(f.child);
  f.child.append = async () => { throw Object.assign(new Error("injected"), { code: "journal_write_failed" }); };
  await assert.rejects(() => mailbox.recordConsumed(f.childTaskId, [sent.messageId]),
    (e) => e.code === "journal_write_failed");
  assert.deepEqual((await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }))
    .map((m) => m.messageId), [sent.messageId]);
  f.child.append = originalAppend;
  await mailbox.recordConsumed(f.childTaskId, [sent.messageId]);
  assert.deepEqual(await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }), []);
});

test("consumption rejects unknown and wrong-recipient IDs without hiding pending messages", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  const parentToChild = await mailbox.send(envelope(f, "for-child"));
  const childToParent = await mailbox.send(envelope(f, "for-parent", {
    senderTaskId: f.childTaskId, recipientTaskId: f.parentTaskId,
  }));
  await assert.rejects(() => mailbox.recordConsumed(f.childTaskId, [parentToChild.messageId, "unknown-id"]),
    (e) => e.code === "invalid_consumption");
  await assert.rejects(() => mailbox.recordConsumed(f.childTaskId, [childToParent.messageId]),
    (e) => e.code === "invalid_consumption");
  await assert.rejects(() => mailbox.recordConsumed(f.childTaskId, [parentToChild.messageId, parentToChild.messageId]),
    (e) => e.code === "invalid_field");
  assert.equal((await allEvents(f.child)).filter((e) => e.type === "message_turn_consumed").length, 0);
  assert.deepEqual((await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }))
    .map((m) => m.messageId), [parentToChild.messageId]);
});

test("already-consumed ID cannot be acknowledged again, including after restart", async (t) => {
  const f = await fixture(t);
  let mailbox = f.makeMailbox();
  const sent = await mailbox.send(envelope(f, "once"));
  await mailbox.recordConsumed(f.childTaskId, [sent.messageId]);
  await assert.rejects(() => mailbox.recordConsumed(f.childTaskId, [sent.messageId]),
    (e) => e.code === "invalid_consumption");
  await f.reopen();
  mailbox = f.makeMailbox();
  assert.deepEqual(await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }), []);
  await assert.rejects(() => mailbox.recordConsumed(f.childTaskId, [sent.messageId]),
    (e) => e.code === "invalid_consumption");
});

test("a fresh mailbox validates and consumes a pending ID after store restart", async (t) => {
  const f = await fixture(t);
  const originalMailbox = f.makeMailbox();
  const sent = await originalMailbox.send(envelope(f, "restarted-observer"));
  await f.reopen();
  const mailbox = f.makeMailbox();
  const event = await mailbox.recordConsumed(f.childTaskId, [sent.messageId]);
  assert.deepEqual(event.payload.consumedMessageIds, [sent.messageId]);
  assert.deepEqual(await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }), []);
});

test("concurrent acknowledgements across mailbox instances append only once", async (t) => {
  const f = await fixture(t);
  const first = f.makeMailbox();
  const second = f.makeMailbox();
  const sent = await first.send(envelope(f, "ack-race"));
  const outcomes = await Promise.allSettled([
    first.recordConsumed(f.childTaskId, [sent.messageId]),
    second.recordConsumed(f.childTaskId, [sent.messageId]),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((o) => o.status === "rejected" && o.reason.code === "invalid_consumption").length, 1);
  assert.equal((await allEvents(f.child)).filter((e) => e.type === "message_turn_consumed").length, 1);
});

test("one conversation lock admits only one opposite-direction send at 49 pending", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  for (let i = 0; i < 49; i += 1) await mailbox.send(envelope(f, `seed-${i}`));
  const parentSend = mailbox.send(envelope(f, "parent-race"));
  const otherMailbox = f.makeMailbox();
  const childSend = otherMailbox.send(envelope(f, "child-race", {
    senderTaskId: f.childTaskId,
    recipientTaskId: f.parentTaskId,
  }));
  const outcomes = await Promise.allSettled([parentSend, childSend]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((o) => o.status === "rejected" && o.reason.code === "queue_full").length, 1);
  const p2c = await mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId });
  const c2p = await mailbox.listPending({ senderTaskId: f.childTaskId, recipientTaskId: f.parentTaskId });
  assert.equal(p2c.length + c2p.length, 50);
});

test("host relationship callback rejects forged envelope linkage and unrelated routes", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  await assert.rejects(() => mailbox.send(envelope(f, "forged", { childTaskId: f.parentTaskId })),
    (e) => e.code === "unauthorized_route");
  await assert.rejects(() => mailbox.send(envelope(f, "foreign", { conversationId: "other" })),
    (e) => e.code === "unauthorized_route");
  assert.equal((await allEvents(f.parent)).filter((e) => e.type === "message_sent").length, 0);
});

test("invalid content is rejected before accessing the recipient journal", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  f.child.getEvents = async () => { throw new Error("recipient was accessed"); };
  await assert.rejects(() => mailbox.send(envelope(f, "invalid", { text: "x".repeat(9000) })),
    (e) => e.code === "field_too_large");
});

test("listPending rejects a forged journal route even when sender and recipient fields match", async (t) => {
  const f = await fixture(t);
  const mailbox = f.makeMailbox();
  await f.parent.append({ type: "message_sent", payload: {
    ...envelope(f, "forged-history", { childTaskId: f.parentTaskId }),
    messageId: "forged-message",
  } });
  await assert.rejects(() => mailbox.listPending({ senderTaskId: f.parentTaskId, recipientTaskId: f.childTaskId }),
    (e) => e.code === "unauthorized_route");
});
