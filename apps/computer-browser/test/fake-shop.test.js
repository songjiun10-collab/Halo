"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShop, FAKE_CARD } = require("../fixtures/fake-shop-server");

async function withShop(fn) {
  const { server, orders } = createShop();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, orders); } finally { server.close(); }
}
const form = (obj) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(obj).toString(), redirect: "manual" });

test("a real-looking checkout records the order only with all details and the fake test card", async () => {
  await withShop(async (base, orders) => {
    const first = await fetch(`${base}/`);
    const cookie = first.headers.get("set-cookie").split(";")[0];
    const withCookie = (init = {}) => ({ ...init, headers: { ...(init.headers || {}), cookie } });
    await fetch(`${base}/add`, withCookie(form({ id: "lamp" })));
    const checkout = await (await fetch(`${base}/checkout`, withCookie())).text();
    assert.match(checkout, /autocomplete="cc-number"/, "card fields are marked the way real shops mark them");
    assert.match(checkout, /Total \$34\.00/);

    const details = { name: "Jamie Test", email: "jamie.test@example.com", address: "1 Example Street" };
    assert.equal((await fetch(`${base}/order`, withCookie(form({ ...details, card: "4111111111111111" })))).status, 400, "a card other than the fake one is refused");
    assert.equal((await fetch(`${base}/order`, withCookie(form({ ...details, card: FAKE_CARD })))).status, 200);

    const kept = await (await fetch(`${base}/__orders`)).json();
    assert.deepEqual(kept.map((o) => [o.items, o.totalCents, o.name]), [[[{ id: "lamp", qty: 1 }], 3400, "Jamie Test"]]);
    assert.equal(JSON.stringify(kept).includes(FAKE_CARD), false, "the order log keeps no card number");
    assert.equal(orders.length, 1);
  });
});

test("an empty cart cannot be ordered", async () => {
  await withShop(async (base) => {
    assert.equal((await fetch(`${base}/order`, form({ name: "a", email: "b", address: "c", card: FAKE_CARD }))).status, 400);
  });
});
