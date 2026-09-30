"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { injectSessions, cookieToElectron } = require("../main/harness/profile-import/session-injector");

const c = (over = {}) => ({ domain: ".claude.ai", name: "sessionKey", value: "sk-secret", path: "/", secure: true, httpOnly: true, sameSite: "lax", expires: 1_900_000_000, ...over });

function fakeSession() {
  const set = [];
  return { set, cookies: { set: async (details) => { set.push(details); } } };
}

test("cookieToElectron builds an https url from the cookie domain and maps fields", () => {
  const d = cookieToElectron(c());
  assert.equal(d.url, "https://claude.ai/");
  assert.equal(d.domain, ".claude.ai");
  assert.equal(d.name, "sessionKey");
  assert.equal(d.sameSite, "lax");
  assert.equal(d.expirationDate, 1_900_000_000);
  assert.equal(cookieToElectron(c({ domain: "chatgpt.com", expires: null, sameSite: "unspecified" })).expirationDate, undefined);
  assert.equal(cookieToElectron(c({ domain: "chatgpt.com", sameSite: "none" })).sameSite, "no_restriction");
  assert.equal("domain" in cookieToElectron(c({ domain: "chatgpt.com", name: "__Host-x", path: "/" })), false);
});

test("injects only allowlisted live cookies into the task session and returns counts without values", async () => {
  const session = fakeSession();
  const vault = { cookiesFor: async ({ domains }) => { assert.deepEqual(domains, ["claude.ai"]); return [c()]; } };
  const result = await injectSessions({ vault, session, domains: ["claude.ai"], nowSeconds: 1_800_000_000 });
  assert.deepEqual(result, { injected: 1, failed: 0, domains: ["claude.ai"] });
  assert.equal(session.set.length, 1);
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
});

test("a cookie that Electron rejects is counted as failed and does not stop the rest", async () => {
  const session = { cookies: { set: async (d) => { if (d.name === "bad") throw new Error("boom"); } } };
  const vault = { cookiesFor: async () => [c({ name: "bad" }), c({ name: "good" })] };
  const result = await injectSessions({ vault, session, domains: ["claude.ai"], nowSeconds: 1 });
  assert.equal(result.injected, 1);
  assert.equal(result.failed, 1);
});

test("injects nothing when the domain list is empty or the vault has no cookies", async () => {
  const session = fakeSession();
  assert.deepEqual(await injectSessions({ vault: { cookiesFor: async () => [] }, session, domains: [], nowSeconds: 1 }), { injected: 0, failed: 0, domains: [] });
  assert.equal(session.set.length, 0);
});
