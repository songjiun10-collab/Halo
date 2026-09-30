"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fetchClaudeSubscription, normalizeClaudeSubscription, USAGE_URL } = require("../main/harness/subscription-usage");
const { importCodexUsage } = require("../main/harness/usage-import");

function configDir(oauth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-sub-"));
  if (oauth) fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
  return dir;
}
const BODY = { five_hour: { utilization: 37.5, resets_at: "2026-09-30T09:00:00Z" }, seven_day: { utilization: 12, resets_at: "2026-10-05T00:00:00Z" }, seven_day_sonnet: null, extra_usage: { utilization: 4, resets_at: null } };

test("claude: sends the stored token only to the fixed usage URL, keeps percentages only, and never leaks the token", async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ...BODY, leak: "x" }) }; };
  const r = await fetchClaudeSubscription({ configDir: configDir({ accessToken: "TOKEN-123", expiresAt: Date.now() + 60000 }), fetchFn, now: 1000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, USAGE_URL);
  assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, "Bearer TOKEN-123");
  assert.equal(calls[0].init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(r.status, "synced");
  assert.equal(r.snapshot.windows.session.usedPercent, 37.5);
  assert.equal(r.snapshot.windows.session.resetsAt, Date.parse("2026-09-30T09:00:00Z"));
  assert.equal(r.snapshot.windows.week.usedPercent, 12);
  assert.equal(r.snapshot.windows.weekSonnet, null);
  assert.equal(r.snapshot.extraUsage.usedPercent, 4);
  assert.equal(r.snapshot.asOf, 1000);
  assert.equal(JSON.stringify(r).includes("TOKEN-123"), false);
  assert.equal(JSON.stringify(r).includes("leak"), false);
});

test("claude: every failure is a status, never a throw, and no request goes out without a usable token", async () => {
  let called = 0;
  const ok = async () => { called += 1; return { ok: true, status: 200, json: async () => BODY }; };
  assert.equal((await fetchClaudeSubscription({ configDir: null, fetchFn: ok })).status, "not_configured");
  assert.equal((await fetchClaudeSubscription({ configDir: configDir(null), fetchFn: ok, platform: "linux" })).status, "no_credentials");
  assert.equal((await fetchClaudeSubscription({ configDir: configDir({ accessToken: "t", expiresAt: 5 }), fetchFn: ok, now: 10 })).status, "token_expired");
  assert.equal(called, 0);

  const dir = configDir({ accessToken: "t" });
  assert.equal((await fetchClaudeSubscription({ configDir: dir, fetchFn: async () => ({ ok: false, status: 401 }) })).status, "unauthorized");
  assert.equal((await fetchClaudeSubscription({ configDir: dir, fetchFn: async () => ({ ok: false, status: 500 }) })).status, "failed");
  assert.equal((await fetchClaudeSubscription({ configDir: dir, fetchFn: async () => { throw new Error("net"); } })).status, "failed");
  assert.equal((await fetchClaudeSubscription({ configDir: dir, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }) })).status, "no_subscription");
});

test("claude: normalization drops non-numeric and negative utilization", () => {
  assert.equal(normalizeClaudeSubscription({ five_hour: { utilization: "9" }, seven_day: { utilization: -1 } }), null);
  assert.equal(normalizeClaudeSubscription(null), null);
});

test("codex: newest recorded rate_limits across rollouts become the plan-quota snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "halo-codex-rl-"));
  const ev = (timestamp, used) => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1790700000 }, secondary: { used_percent: used / 2, window_minutes: 10080, resets_at: 1791000000 } } } });
  fs.writeFileSync(path.join(root, "a.jsonl"), [ev("2026-09-29T01:00:00Z", 10), ev("2026-09-29T02:00:00Z", 20)].join("\n"));
  fs.writeFileSync(path.join(root, "b.jsonl"), ev("2026-09-29T01:30:00Z", 99));
  const r = await importCodexUsage({ root });
  assert.equal(r.subscription.provider, "codex");
  assert.equal(r.subscription.windows.primary.usedPercent, 20);
  assert.equal(r.subscription.windows.primary.windowMinutes, 300);
  assert.equal(r.subscription.windows.primary.resetsAt, 1790700000 * 1000);
  assert.equal(r.subscription.windows.secondary.usedPercent, 10);
  assert.equal(r.subscription.asOf, Date.parse("2026-09-29T02:00:00Z"));
});
