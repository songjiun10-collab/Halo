"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isBlockedUrl, installAgentRequestFilter } = require("../main/harness/agent-request-filter");

test("known ad and tracker hosts are blocked, including subdomains", () => {
  assert.equal(isBlockedUrl("https://securepubads.g.doubleclick.net/gampad/ads"), true);
  assert.equal(isBlockedUrl("https://cdn.taboola.com/libtrc/x.js"), true);
  assert.equal(isBlockedUrl("https://doubleclick.net/"), true);
});

test("ordinary sites, look-alike hosts and non-http URLs are not blocked", () => {
  assert.equal(isBlockedUrl("https://www.wikipedia.org/"), false);
  assert.equal(isBlockedUrl("https://notdoubleclick.net/"), false);
  assert.equal(isBlockedUrl("https://doubleclick.net.evil.test/"), false);
  assert.equal(isBlockedUrl("data:text/html,hi"), false);
  assert.equal(isBlockedUrl("not a url"), false);
});

test("the session hook cancels blocked subresources but never the main page", () => {
  let handler;
  const session = { webRequest: { onBeforeRequest: (_filter, fn) => { handler = fn; } } };
  assert.equal(installAgentRequestFilter(session), true);
  const run = (details) => { let result; handler(details, (r) => { result = r; }); return result; };
  assert.deepEqual(run({ url: "https://x.doubleclick.net/a", resourceType: "subFrame" }), { cancel: true });
  assert.deepEqual(run({ url: "https://doubleclick.net/", resourceType: "mainFrame" }), { cancel: false });
  assert.deepEqual(run({ url: "https://site.test/app.js", resourceType: "script" }), { cancel: false });
});

test("a session without webRequest is left alone", () => {
  assert.equal(installAgentRequestFilter({}), false);
});
