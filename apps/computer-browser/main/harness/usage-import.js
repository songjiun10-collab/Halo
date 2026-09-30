"use strict";

// Reads REAL usage the local CLIs already recorded: Claude Code session
// transcripts (~/.claude/projects/**/*.jsonl) and Codex rollouts
// (~/.codex/sessions/**/*.jsonl). Only numeric usage fields are read; message
// text is parsed past but never kept. Results are recomputed from scratch on
// each sync, so importing twice never double counts.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

function num(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

async function listJsonl(root) {
  const files = [];
  async function walk(dir, depth) {
    if (files.length >= MAX_FILES || depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  await walk(root, 0);
  return files;
}

async function forEachLine(file, onObject) {
  const stat = await fsp.stat(file);
  if (stat.size > MAX_FILE_BYTES) return false;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > 8 * 1024 * 1024) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj !== null && typeof obj === "object") onObject(obj);
  }
  return true;
}

function emptyImported(provider) {
  return { provider, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, firstAt: null, lastAt: null };
}

function widen(totals, timestamp) {
  const t = typeof timestamp === "string" ? Date.parse(timestamp) : Number.isFinite(timestamp) ? timestamp : NaN;
  if (!Number.isFinite(t)) return;
  if (totals.firstAt === null || t < totals.firstAt) totals.firstAt = t;
  if (totals.lastAt === null || t > totals.lastAt) totals.lastAt = t;
}

// A streamed assistant message is logged several times with growing usage under
// one message id, so keep the last entry per id. Cost comes from the CLI's own
// cumulative cost-state record (highest per session: it is cumulative, and one session can appear in several files).
async function importClaudeUsage({ root }) {
  const totals = emptyImported("claude");
  const costBySession = new Map();
  const tokensByMessage = new Map();
  let files = 0;
  for (const file of await listJsonl(root)) {
    let usedFile = false;
    const ok = await forEachLine(file, (o) => {
      if (o.type === "cost-state" && typeof o.sessionId === "string" && Number.isFinite(o.totalCostUSD)) {
        costBySession.set(o.sessionId, Math.max(costBySession.get(o.sessionId) ?? 0, num(o.totalCostUSD)));
        usedFile = true;
      } else if (o.type === "assistant" && o.message && typeof o.message === "object" && o.message.usage && typeof o.message.id === "string") {
        const u = o.message.usage;
        tokensByMessage.set(`${o.sessionId}:${o.message.id}`, [num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)]);
        widen(totals, o.timestamp);
        usedFile = true;
      }
    }).catch(() => false);
    if (ok && usedFile) files += 1;
  }
  for (const [i, o, r, c] of tokensByMessage.values()) {
    totals.inputTokens += i; totals.outputTokens += o; totals.cacheReadTokens += r; totals.cacheCreationTokens += c;
  }
  for (const cost of costBySession.values()) totals.costUsd += cost;
  totals.sessions = new Set([...costBySession.keys(), ...[...tokensByMessage.keys()].map((k) => k.split(":")[0])]).size;
  totals.files = files;
  return totals;
}

function codexWindow(raw) {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.used_percent) || raw.used_percent < 0) return null;
  const minutes = Number.isFinite(raw.window_minutes) && raw.window_minutes > 0 ? raw.window_minutes : null;
  const resetsAt = Number.isFinite(raw.resets_at) ? (raw.resets_at < 1e12 ? raw.resets_at * 1000 : raw.resets_at) : null;
  return { usedPercent: Math.min(raw.used_percent, 1000), windowMinutes: minutes, resetsAt };
}

function codexWindows(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const windows = { primary: codexWindow(rateLimits.primary), secondary: codexWindow(rateLimits.secondary) };
  return windows.primary || windows.secondary ? windows : null;
}

// Codex rollouts log a cumulative total_token_usage in token_count events;
// the last one per file is that session's total. Codex reports no dollar cost.
async function importCodexUsage({ root }) {
  const totals = emptyImported("codex");
  let files = 0;
  let latestLimits = null; // newest rate_limits Codex itself recorded (percent of plan window used)
  for (const file of await listJsonl(root)) {
    let last = null;
    const ok = await forEachLine(file, (o) => {
      const p = o.payload;
      if (p && p.type === "token_count") {
        const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
        if (p.info && p.info.total_token_usage) {
          last = p.info.total_token_usage;
          widen(totals, o.timestamp);
        }
        const windows = codexWindows(p.rate_limits);
        if (windows && Number.isFinite(at) && (!latestLimits || at > latestLimits.asOf)) latestLimits = { provider: "codex", windows, asOf: at };
      }
    }).catch(() => false);
    if (ok && last) {
      const cached = num(last.cached_input_tokens);
      totals.inputTokens += Math.max(0, num(last.input_tokens) - cached);
      totals.cacheReadTokens += cached;
      totals.outputTokens += num(last.output_tokens);
      totals.sessions += 1;
      files += 1;
    }
  }
  totals.files = files;
  if (latestLimits) totals.subscription = latestLimits;
  return totals;
}

module.exports = { importClaudeUsage, importCodexUsage };
