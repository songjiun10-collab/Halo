"use strict";

// Subscription quota for the Claude account, read the same way the CLI's own
// /usage screen does: GET https://api.anthropic.com/api/oauth/usage with the
// OAuth token Claude Code already stored locally (endpoint, headers and
// response fields taken from the installed CLI, v2.1.x). The token is read on
// demand, sent only to that fixed host, and never stored, logged or returned;
// only percentages and reset times are kept.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 5000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function pct(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 1000) : null;
}

function resetMs(value) {
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
}

function windowOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = pct(raw.utilization);
  return usedPercent === null ? null : { usedPercent, resetsAt: resetMs(raw.resets_at) };
}

function normalizeClaudeSubscription(body) {
  if (!body || typeof body !== "object") return null;
  const windows = {
    session: windowOf(body.five_hour),
    week: windowOf(body.seven_day),
    weekSonnet: windowOf(body.seven_day_sonnet),
    weekOpus: windowOf(body.seven_day_opus),
  };
  if (!Object.values(windows).some(Boolean)) return null;
  const extra = body.extra_usage && typeof body.extra_usage === "object" ? windowOf(body.extra_usage) : null;
  return { provider: "claude", windows, ...(extra ? { extraUsage: extra } : {}) };
}

function readKeychain(execFn) {
  return new Promise((resolve) => {
    execFn("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

async function readOauth({ configDir, platform, execFn }) {
  let raw = null;
  try { raw = await fsp.readFile(path.join(configDir, ".credentials.json"), "utf8"); } catch { /* try keychain */ }
  if (raw === null && platform === "darwin") raw = await readKeychain(execFn);
  if (raw === null) return null;
  try {
    const oauth = JSON.parse(raw).claudeAiOauth;
    return oauth && typeof oauth.accessToken === "string" ? oauth : null;
  } catch {
    return null;
  }
}

// Never throws; always resolves to { status, snapshot? } so a sync can report
// exactly why there is no subscription number.
async function fetchClaudeSubscription({ configDir, fetchFn = globalThis.fetch, now = Date.now(), platform = process.platform, execFn = execFile } = {}) {
  if (!configDir || typeof fetchFn !== "function") return { status: "not_configured" };
  const oauth = await readOauth({ configDir, platform, execFn });
  if (!oauth) return { status: "no_credentials" };
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= now) return { status: "token_expired" };
  try {
    const response = await fetchFn(USAGE_URL, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": OAUTH_BETA, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
    if (!response.ok) return { status: "failed" };
    const snapshot = normalizeClaudeSubscription(await response.json());
    // The CLI itself shows "only available for subscription plans" when empty.
    return snapshot ? { status: "synced", snapshot: { ...snapshot, asOf: now } } : { status: "no_subscription" };
  } catch {
    return { status: "failed" };
  }
}

module.exports = { fetchClaudeSubscription, normalizeClaudeSubscription, USAGE_URL };
