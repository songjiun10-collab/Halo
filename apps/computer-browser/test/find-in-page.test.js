"use strict";

// find-in-page.js: one read-only search shared by the human Mod+F find bar and
// the agent `find` action. Two engines -- Electron findInPage()/found-in-page
// (counts) and the Chromium CDP page's window.find (found/not-found).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { findInPageOn, normalizeQuery } = require("../main/harness/find-in-page");

test("normalizeQuery strips control characters and bounds the query", () => {
  assert.equal(normalizeQuery("  refund  "), "  refund  ");
  assert.equal(normalizeQuery("a\u0000b"), "ab");
  assert.equal(normalizeQuery(""), null);
  assert.equal(normalizeQuery("   "), null);
  assert.equal(normalizeQuery("\u0001\u0002"), null);
  assert.equal(normalizeQuery(123), null);
  assert.equal(normalizeQuery("x".repeat(500)).length, 200, "character cap");
  assert.equal(normalizeQuery("가".repeat(200)) === null, true, "256-byte cap rejects an oversized CJK query");
});

test("the CDP branch runs window.find with the direction and reports found/not-found", async () => {
  const scripts = [];
  // window.find(query, caseSensitive=false, backwards, wrap=true, ...)
  const wc = { executeJavaScript: async (script) => { scripts.push(script); return script.includes("false, false, true"); } };
  // forward
  assert.deepEqual(await findInPageOn(wc, "policy", { forward: true }), { ok: true, found: true });
  assert.ok(scripts.at(-1).includes(JSON.stringify("policy")));
  assert.ok(scripts.at(-1).includes("false, false, true"), "forward => backwards=false, wrap=true");
  // backward, not found
  assert.deepEqual(await findInPageOn(wc, "policy", { forward: false }), { ok: true, found: false });
  assert.ok(scripts.at(-1).includes("false, true, true"), "backward => backwards=true, wrap=true");
});

test("a page without window.find reports find_unsupported rather than a false miss", async () => {
  const wc = { executeJavaScript: async () => null };
  assert.deepEqual(await findInPageOn(wc, "x"), { ok: false, found: false, errorCode: "find_unsupported" });
});

test("the Electron branch uses findInPage and resolves from the correlated found-in-page event", async () => {
  const wc = new EventEmitter();
  let asked = null;
  wc.findInPage = (text, options) => {
    asked = { text, options };
    setImmediate(() => wc.emit("found-in-page", {}, { requestId: 7, matches: 3, activeMatchOrdinal: 2 }));
    return 7;
  };
  const result = await findInPageOn(wc, "refund", { forward: false });
  assert.deepEqual(asked, { text: "refund", options: { forward: false, findNext: true } });
  assert.deepEqual(result, { ok: true, found: true, matches: 3, active: 2 });
});

test("a found-in-page event for a different request is ignored", async () => {
  const wc = new EventEmitter();
  wc.findInPage = () => {
    setImmediate(() => {
      wc.emit("found-in-page", {}, { requestId: 999, matches: 5, activeMatchOrdinal: 1 });
      wc.emit("found-in-page", {}, { requestId: 7, matches: 1, activeMatchOrdinal: 1 });
    });
    return 7;
  };
  const result = await findInPageOn(wc, "refund");
  assert.deepEqual(result, { ok: true, found: true, matches: 1, active: 1 });
});

test("a destroyed or unavailable target fails closed", async () => {
  assert.deepEqual(await findInPageOn(null, "x"), { ok: false, found: false, errorCode: "find_target_unavailable" });
  assert.deepEqual(await findInPageOn({ isDestroyed: () => true }, "x"), { ok: false, found: false, errorCode: "find_target_unavailable" });
  assert.deepEqual(await findInPageOn({}, "x"), { ok: false, found: false, errorCode: "find_unsupported" });
});
