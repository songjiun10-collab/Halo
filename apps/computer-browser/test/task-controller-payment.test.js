"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const PAY = { type: "click", elementId: "1" };

async function run(t, { request, actions = [PAY], total = "Total $12.50", approver = async () => ({ decision: "allow", reasons: [] }), controllerOptions = { paymentsEnabled: true }, formAction = "https://shop.example/pay", seed }) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-payment-controller-"));
  const store = await TaskStore.create({ originalRequest: request }, { storageRoot });
  if (seed) await seed(store);
  const executed = [];
  let planned = 0;
  const browser = {
    supportsAction: () => true,
    observe: async () => ({ id: "obs", documentEpoch: 1, url: "https://shop.example/checkout", text: `Item $10.00\nShipping $2.50\n${total}`, elements: [
      { elementId: "0", role: "link", name: "Cart", href: "https://shop.example/cart" },
      { elementId: "1", role: "button", name: "Place order", formAction, formMethod: "post" },
    ] }),
    execute: async (action) => { executed.push(action); return { status: "ok" }; },
  };
  const controller = new TaskController({
    store, browser, permissionMode: "interact", approve: approver, hostVerifier: () => true, ...controllerOptions,
    planner: { next: async (c) => {
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      planned += 1;
      return planned === 1 ? { ...base, kind: "actions", actions } : { ...base, kind: "finish", evidenceIds: [] };
    } },
  });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  const notes = (await store.getEvents()).filter((e) => e.type === "note").map((e) => e.payload);
  return { controller, executed, notes, get planned() { return planned; } };
}
const kinds = (r) => r.notes.map((n) => n.kind);

test("a clear chat order pays at once: no approval queue, mandate and payment are journaled", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘" });
  assert.equal(r.executed.length, 1);
  assert.deepEqual(r.executed[0], PAY);
  assert.equal(r.controller.getSnapshot().approvalQueue.length, 0);
  assert.ok(kinds(r).includes("mandate_granted"));
  const paid = r.notes.find((n) => n.kind === "payment_authorized");
  assert.deepEqual({ currency: paid.currency, amountMinor: paid.amountMinor, maxAmountMinor: paid.maxAmountMinor, origin: paid.origin }, { currency: "USD", amountMinor: 1250, maxAmountMinor: 2000, origin: "https://shop.example" });
  assert.equal(JSON.stringify(r.notes).includes("4111"), false, "no card data in the journal");
});

test("a total over the user's cap pauses with a question instead of paying or refusing", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", total: "Total $25.00" });
  assert.equal(r.executed.length, 0);
  const snap = r.controller.getSnapshot();
  assert.equal(snap.state, "paused");
  assert.equal(snap.pauseReason, "need_user");
  assert.match(snap.needUserReason, /한도/);
  assert.ok(kinds(r).includes("payment_question"));
  assert.equal(kinds(r).includes("payment_authorized"), false);
});

test("an unreadable total asks, and a different site asks", async (t) => {
  const none = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", total: "thanks for shopping" });
  assert.equal(none.executed.length, 0);
  assert.match(none.controller.getSnapshot().needUserReason, /금액/);
  const other = await run(t, { request: "other.example에서 $20 이하로 구매해줘" });
  assert.equal(other.executed.length, 0);
  assert.match(other.controller.getSnapshot().needUserReason, /다른 사이트/);
});

test("an unclear order asks before doing anything", async (t) => {
  for (const [request, reason] of [["물티슈 사줘", /사이트/], ["shop.example에서 물티슈 사줘", /한도/], ["철수에게 5만원 송금해줘", /송금/]]) {
    const r = await run(t, { request });
    assert.equal(r.executed.length, 0, request);
    assert.equal(r.planned, 0, "the planner is not even called");
    const snap = r.controller.getSnapshot();
    assert.equal(snap.pauseReason, "need_user");
    assert.match(snap.needUserReason, reason);
  }
});

test("without a payment order, a payment click is not auto-run: the human gate decides, as before", async (t) => {
  for (const request of ["update my profile", "shop.example 결제 직전까지만 해줘 3만원", "shop.example에서 사지 마 $20"]) {
    const r = await run(t, { request });
    assert.equal(r.executed.length, 0, request);
    assert.equal(r.controller.getSnapshot().approvalQueue.length, 1, request);
    assert.equal(kinds(r).includes("payment_authorized"), false);
  }
});

test("one order pays once: a second payment click is not covered", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", actions: [PAY, PAY] });
  assert.equal(r.executed.length, 1);
  assert.equal(r.notes.filter((n) => n.kind === "payment_authorized").length, 1);
  assert.equal(r.controller.getSnapshot().approvalQueue.length, 1, "the second click falls back to the human gate");
});

test("the independent approver still has the last word on a covered payment", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", approver: async () => ({ decision: "deny", reasons: ["policy"] }) });
  assert.equal(r.executed.length, 0);
  assert.equal(r.controller.getSnapshot().approvalQueue.length, 0);
});

test("the user's answer to the question (an amendment) completes the order and the payment then runs", async (t) => {
  const r = await run(t, { request: "shop.example에서 물티슈 사줘" });
  assert.equal(r.controller.getSnapshot().pauseReason, "need_user");
  assert.equal(r.executed.length, 0);
  await r.controller.amend({ text: "한도는 $20 이하로 해줘" });
  await r.controller.resume();
  assert.equal(r.executed.length, 1, "the click ran once the cap was given");
  assert.equal(r.controller.getSnapshot().approvalQueue.length, 0);
});

test("a resume without an answer does not ask again and does not pay", async (t) => {
  const r = await run(t, { request: "shop.example에서 물티슈 사줘" });
  await r.controller.resume();
  assert.equal(r.executed.length, 0);
  assert.equal(r.notes.filter((n) => n.kind === "payment_question").length, 1);
});

test("kill switch: with payments off a clear order grants no mandate and records no payment", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", controllerOptions: { paymentsEnabled: false } });
  assert.equal(kinds(r).includes("mandate_granted"), false);
  assert.equal(kinds(r).includes("payment_authorized"), false);
  assert.equal(kinds(r).includes("payment_question"), false, "off means the old gates decide, not a new question");
  assert.equal(r.executed.length, 0, "the pay click never reaches the browser without a human");
  assert.equal(r.controller.getSnapshot().approvalQueue.length, 1, "the existing human gate holds the click");
});

test("kill switch: turning payments off mid-task revokes a mandate that was already granted", async (t) => {
  const on = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", actions: [{ type: "scroll", direction: "down" }] });
  assert.ok(kinds(on).includes("mandate_granted"));
  on.controller.setPolicySettings({ paymentsEnabled: false });
  assert.ok(on.controller._mandates.every((m) => m.revoked === true));
});

test("payments are off by default: without an explicit opt-in a clear order grants nothing", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", controllerOptions: {} });
  assert.equal(kinds(r).includes("mandate_granted"), false);
  assert.equal(r.executed.length, 0);
});

test("a payment button that submits to another site is not covered by this site's mandate", async (t) => {
  const r = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", formAction: "https://evil.example/pay" });
  assert.equal(r.executed.length, 0, "the cross-origin submit never runs");
  assert.equal(kinds(r).includes("payment_authorized"), false);
  const snap = r.controller.getSnapshot();
  assert.equal(snap.pauseReason, "need_user");
  assert.match(snap.needUserReason, /다른 사이트/);
});

test("Full mode skips approval for ordinary actions but a payment click without a covering order still waits for the person", async (t) => {
  // Payments off (default): nothing covers the click, and Full's bypass must not become a silent purchase.
  const off = await run(t, { request: "shop.example 둘러봐줘", controllerOptions: { permissionMode: "full" } });
  assert.equal(off.executed.length, 0, "the payment click did not run");
  assert.equal(off.controller.getSnapshot().approvalQueue.length, 1, "it waits for the person");

  // Payments on but no order for this site: same.
  const noOrder = await run(t, { request: "shop.example 둘러봐줘", controllerOptions: { permissionMode: "full", paymentsEnabled: true } });
  assert.equal(noOrder.executed.length, 0);
  assert.equal(noOrder.controller.getSnapshot().approvalQueue.length, 1);

  // An ordinary click in Full still runs without asking.
  const plain = await run(t, { request: "shop.example 둘러봐줘", actions: [{ type: "click", elementId: "0" }], controllerOptions: { permissionMode: "full" } });
  assert.equal(plain.executed.length, 1);
  assert.equal(plain.controller.getSnapshot().approvalQueue.length, 0);

  // A covering order still pays at once in Full.
  const ordered = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", controllerOptions: { permissionMode: "full", paymentsEnabled: true } });
  assert.equal(ordered.executed.length, 1);
  assert.ok(kinds(ordered).includes("payment_authorized"));
});

test("an order already paid long ago in a long journal is not paid again after a restart", async (t) => {
  const r = await run(t, {
    request: "shop.example에서 $20 이하로 구매해줘",
    seed: async (store) => {
      // The payment note sits past the first 200-event page the store returns by default.
      for (let i = 0; i < 260; i += 1) await store.append({ type: "note", payload: { kind: "filler", i } });
      await store.append({ type: "note", payload: { kind: "payment_authorized", mandateId: "earlier", origin: "https://shop.example", currency: "USD", amountMinor: 1250, maxAmountMinor: 2000, control: "Place order" } });
    },
  });
  assert.equal(kinds(r).includes("mandate_granted"), false, "no second mandate for an order that already paid");
  assert.equal(r.executed.length, 0, "the payment click falls back to the human gate");
  assert.equal(r.controller.getSnapshot().approvalQueue.length, 1);
});

test("a request written by a model (team room propose_task) never becomes a payment order, even with payments on", async (t) => {
  // The same words that pay at once when the person wrote them.
  const person = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", controllerOptions: { paymentsEnabled: true, requestAuthor: "person" } });
  assert.ok(kinds(person).includes("payment_authorized"), "control: the person's own order still pays");

  const model = await run(t, { request: "shop.example에서 $20 이하로 구매해줘", controllerOptions: { paymentsEnabled: true, requestAuthor: "model" } });
  assert.equal(kinds(model).includes("mandate_granted"), false, "no mandate is minted from model-written text");
  assert.equal(kinds(model).includes("payment_authorized"), false);
  assert.equal(model.executed.length, 0, "the payment click is not run");
  assert.equal(model.controller.getSnapshot().approvalQueue.length, 1, "it waits for the person, as with payments off");

  // An absent author means the person (the chat path), so existing behavior is unchanged.
  const unset = await run(t, { request: "shop.example에서 $20 이하로 구매해줘" });
  assert.ok(kinds(unset).includes("payment_authorized"));

  assert.throws(() => new (require("../main/harness/task-controller").TaskController)({ store: {}, browser: {}, planner: {}, requestAuthor: "robot" }), { code: "invalid_config" });
});
