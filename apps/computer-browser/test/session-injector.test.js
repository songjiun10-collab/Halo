"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { injectSessions, cookieToElectron, clearSessionCookies } = require("../main/harness/profile-import/session-injector");

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

test("clears imported cookies for a revoked domain and its subdomains without touching other sites", async () => {
  const cookies = [
    { domain: ".claude.ai", name: "session", path: "/", secure: true },
    { domain: "accounts.claude.ai", name: "account", path: "/auth", secure: true },
    { domain: ".chatgpt.com", name: "session", path: "/", secure: true },
    { domain: ".notclaude.ai", name: "other", path: "/", secure: true },
  ];
  const removed = [];
  const session = { cookies: {
    get: async (filter) => { assert.deepEqual(filter, {}); return cookies.map((cookie) => ({ ...cookie })); },
    remove: async (url, name) => {
      removed.push([url, name]);
      const parsed = new URL(url);
      const index = cookies.findIndex((cookie) => cookie.name === name && cookie.domain.replace(/^\./, "") === parsed.hostname && cookie.path === parsed.pathname);
      if (index >= 0) cookies.splice(index, 1);
    },
  } };

  const result = await clearSessionCookies(session, ["claude.ai"]);

  assert.deepEqual(result, { removed: 2, failed: 0 });
  assert.deepEqual(removed, [
    ["https://claude.ai/", "session"],
    ["https://accounts.claude.ai/auth", "account"],
  ]);
});

test("reports failed revocation when Electron leaves a matching cookie behind", async () => {
  const session = { cookies: {
    get: async () => [{ domain: ".claude.ai", name: "session", path: "/", secure: true }],
    remove: async () => {},
  } };

  assert.deepEqual(await clearSessionCookies(session, ["claude.ai"]), { removed: 0, failed: 1 });
});

test("revocation accepts a legacy subdomain group without broadening new allowlist admission", async () => {
  const cookies = [
    { domain: ".api.claude.ai", name: "legacy", path: "/", secure: true },
    { domain: ".other.claude.ai", name: "unrelated", path: "/", secure: true },
  ];
  const removed = [];
  const session = { cookies: {
    get: async () => cookies.map((cookie) => ({ ...cookie })),
    remove: async (url, name) => {
      removed.push([url, name]);
      const host = new URL(url).hostname;
      const index = cookies.findIndex((cookie) => cookie.name === name && cookie.domain.replace(/^\./, "") === host);
      if (index >= 0) cookies.splice(index, 1);
    },
  } };
  assert.deepEqual(await clearSessionCookies(session, ["api.claude.ai"]), { removed: 1, failed: 0 });
  assert.deepEqual(removed, [["https://api.claude.ai/", "legacy"]]);
});
