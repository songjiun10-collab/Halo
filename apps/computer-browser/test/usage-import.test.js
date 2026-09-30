"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { importClaudeUsage, importCodexUsage } = require("../main/harness/usage-import");
const { UsageLedger } = require("../main/harness/usage-ledger");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "halo-usage-import-"));
}
function jsonl(file, rows, extra = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + extra);
}
const assistant = (session, id, usage, timestamp = "2026-09-29T01:00:00.000Z") => ({ type: "assistant", sessionId: session, timestamp, message: { id, usage, content: [{ type: "text", text: "SECRET PROMPT TEXT" }] } });

test("claude: dedupes streamed messages by id (last wins), takes max cumulative cost across files, ignores junk lines", async () => {
  const root = tmp();
  jsonl(path.join(root, "proj-a", "s1.jsonl"), [
    assistant("s1", "m1", { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    assistant("s1", "m1", { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, "2026-09-29T02:00:00.000Z"),
    assistant("s1", "m2", { input_tokens: 1, output_tokens: 7 }),
    { type: "cost-state", sessionId: "s1", totalCostUSD: 4.5 },
    { type: "cost-state", sessionId: "s1", totalCostUSD: 9.25 },
    { type: "user", message: { usage: { input_tokens: 999 } } },
  ], "not json\n");
  jsonl(path.join(root, "proj-b", "s1.jsonl"), [{ type: "cost-state", sessionId: "s1", totalCostUSD: 0.01 }]);
  jsonl(path.join(root, "proj-b", "s2.jsonl"), [assistant("s2", "m1", { input_tokens: 3, output_tokens: 3 }), { type: "cost-state", sessionId: "s2", totalCostUSD: 1 }]);

  const r = await importClaudeUsage({ root });
  assert.equal(r.provider, "claude");
  assert.equal(r.sessions, 2);
  assert.equal(r.inputTokens, 2 + 1 + 3);
  assert.equal(r.outputTokens, 50 + 7 + 3);
  assert.equal(r.cacheReadTokens, 100);
  assert.equal(r.cacheCreationTokens, 5);
  assert.equal(r.costUsd, 10.25);
  assert.equal(JSON.stringify(r).includes("SECRET"), false, "no message text is retained");
  assert.equal(r.firstAt, Date.parse("2026-09-29T01:00:00.000Z"));
  assert.equal(r.lastAt, Date.parse("2026-09-29T02:00:00.000Z"));
});

test("codex: uses the last cumulative token_count per rollout and splits cached input", async () => {
  const root = tmp();
  const ev = (total, timestamp) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } });
  jsonl(path.join(root, "2026", "09", "29", "rollout-a.jsonl"), [
    ev({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, "2026-09-29T01:00:00Z"),
    ev({ input_tokens: 300, cached_input_tokens: 100, output_tokens: 30 }, "2026-09-29T01:05:00Z"),
  ]);
  jsonl(path.join(root, "2026", "09", "30", "rollout-b.jsonl"), [ev({ input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 }, "2026-09-30T01:00:00Z")]);
  jsonl(path.join(root, "2026", "09", "30", "rollout-empty.jsonl"), [{ type: "session_meta", payload: {} }]);

  const r = await importCodexUsage({ root });
  assert.equal(r.sessions, 2);
  assert.equal(r.inputTokens, 200 + 50);
  assert.equal(r.cacheReadTokens, 100);
  assert.equal(r.outputTokens, 35);
  assert.equal(r.costUsd, 0);
});

test("missing roots import as zero sessions; symlinks are not followed", async () => {
  assert.equal((await importClaudeUsage({ root: path.join(tmp(), "nope") })).sessions, 0);
  const root = tmp();
  const outside = tmp();
  jsonl(path.join(outside, "x.jsonl"), [assistant("s9", "m", { input_tokens: 9, output_tokens: 9 })]);
  fs.symlinkSync(outside, path.join(root, "link"));
  assert.equal((await importClaudeUsage({ root })).sessions, 0);
});

test("ledger: imported totals replace on re-sync (no double count) and drive limits", async () => {
  const ledger = new UsageLedger({});
  ledger.record("t", "claude", { provider: "claude", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1, durationMs: 1 });
  ledger.setLimit("claude", { tokens: 1000, costUsd: 100 });
  assert.equal(ledger.summary().limits.claude.basis, "harness");

  const base = { provider: "claude", sessions: 1, inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 40, firstAt: 1, lastAt: 2 };
  ledger.setImported("claude", base);
  ledger.setImported("claude", { ...base, outputTokens: 200 });
  const s = ledger.summary();
  assert.equal(s.imported.claude.outputTokens, 200);
  assert.equal(s.limits.claude.basis, "imported");
  assert.equal(s.limits.claude.remainingTokens, 500);
  assert.equal(s.limits.claude.remainingCostUsd, 60);
  assert.equal(s.byProvider.claude.calls, 1, "harness totals are untouched");
  assert.throws(() => ledger.setImported("claude", { ...base, provider: "codex" }), (e) => e.code === "invalid_provider");
});
