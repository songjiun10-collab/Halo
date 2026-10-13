#!/usr/bin/env node
"use strict";

// A fake shop for benchmarks with made-up people and made-up cards. Nothing here is real:
// the persona, the card number and the address exist only in fixtures/fake-shop-tasks.json.
// It has a catalog, a cart, a checkout form (with card fields marked the way real shops mark
// them, so Halo's card and secret rules see what they would see on a real site) and a
// confirmation page. Every submitted order is kept at GET /__orders, so a grader can compare
// what was ordered against what the task asked for.
//
//   node fixtures/fake-shop-server.js [--port 8099]
//   curl localhost:8099/__orders

const http = require("node:http");
const { URL } = require("node:url");

const PRODUCTS = [
  { id: "mug", name: "Ceramic Mug", price: 1200 },
  { id: "notebook", name: "Dot Notebook", price: 850 },
  { id: "lamp", name: "Desk Lamp", price: 3400 },
];
// The only card number this shop accepts. It is the public Visa test number and fails no real account.
const FAKE_CARD = "4242424242424242";

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body><h1>${esc(title)}</h1>${body}<p><a href="/">Shop</a> · <a href="/cart">Cart</a></p></body>`;

function createShop() {
  const carts = new Map();   // session -> { productId: qty }
  const orders = [];
  let nextSession = 1;

  function session(req, res) {
    const cookie = /sid=(\d+)/.exec(req.headers.cookie || "");
    if (cookie && carts.has(cookie[1])) return cookie[1];
    const id = String(nextSession++);
    carts.set(id, {});
    res.setHeader("set-cookie", `sid=${id}; Path=/; HttpOnly`);
    return id;
  }
  const lines = (cart) => Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ ...PRODUCTS.find((p) => p.id === id), qty }));
  const total = (cart) => lines(cart).reduce((sum, l) => sum + l.price * l.qty, 0);

  function body(req) {
    return new Promise((resolve) => { let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 20000) req.destroy(); }); req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw)))); });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/__orders") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(orders)); return; }
    const sid = session(req, res);
    const cart = carts.get(sid);
    if (req.method === "POST" && url.pathname === "/add") {
      const f = await body(req);
      if (PRODUCTS.some((p) => p.id === f.id)) cart[f.id] = (cart[f.id] || 0) + 1;
      res.statusCode = 303; res.setHeader("location", "/cart"); res.end(); return;
    }
    if (req.method === "POST" && url.pathname === "/order") {
      const f = await body(req);
      const cardOk = (f.card || "").replace(/\s|-/g, "") === FAKE_CARD;
      if (!lines(cart).length || !f.name || !f.email || !f.address || !cardOk) {
        res.statusCode = 400;
        res.end(page("Order problem", `<p>Please fill in name, email, address and a valid card.</p><p><a href="/checkout">Back to checkout</a></p>`)); return;
      }
      orders.push({ at: new Date().toISOString(), items: lines(cart).map(({ id, qty }) => ({ id, qty })), totalCents: total(cart), name: f.name, email: f.email, address: f.address, cardAccepted: true });
      carts.set(sid, {});
      res.end(page("Order confirmed", `<p>Thank you, ${esc(f.name)}. Order #${orders.length} confirmed.</p><p>Total ${money(orders[orders.length - 1].totalCents)}</p>`)); return;
    }
    if (url.pathname === "/cart") {
      const l = lines(cart);
      res.end(page("Cart", l.length ? `<ul>${l.map((x) => `<li>${esc(x.name)} x ${x.qty} - ${money(x.price * x.qty)}</li>`).join("")}</ul><p>Total ${money(total(cart))}</p><a href="/checkout">Go to checkout</a>` : "<p>Your cart is empty.</p>")); return;
    }
    if (url.pathname === "/checkout") {
      res.end(page("Checkout", `<p>Total ${money(total(cart))}</p>
<form method="post" action="/order">
<label>Full name <input name="name" autocomplete="name"></label><br>
<label>Email <input name="email" type="email" autocomplete="email"></label><br>
<label>Address <input name="address" autocomplete="street-address"></label><br>
<label>Card number <input name="card" autocomplete="cc-number" inputmode="numeric"></label><br>
<label>Expiry <input name="exp" autocomplete="cc-exp"></label><br>
<label>CVC <input name="cvc" autocomplete="cc-csc"></label><br>
<button type="submit">Place order</button></form>`)); return;
    }
    if (url.pathname === "/") {
      res.end(page("Fake Shop", `<ul>${PRODUCTS.map((p) => `<li>${esc(p.name)} - ${money(p.price)} <form method="post" action="/add" style="display:inline"><input type="hidden" name="id" value="${p.id}"><button type="submit">Add ${esc(p.name)} to cart</button></form></li>`).join("")}</ul>`)); return;
    }
    res.statusCode = 404; res.end(page("Not found", ""));
  });
  return { server, orders };
}

if (require.main === module) {
  const i = process.argv.indexOf("--port");
  const port = i > -1 ? Number(process.argv[i + 1]) : 8099;
  createShop().server.listen(port, "127.0.0.1", () => console.log(`fake shop on http://127.0.0.1:${port} (orders at /__orders)`));
}

module.exports = { createShop, PRODUCTS, FAKE_CARD };
