"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeUsage } = require("../shared/usage");
const { UsageLedger } = require("../main/harness/usage-ledger");

test("normalizes a claude CLI envelope and a codex-style usage object", () => {
  const claude = normalizeUsage("claude", {
    result: "ignored", total_cost_usd: 0.25, duration_ms: 1200,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
  });
  assert.deepEqual(claude, { provider: "claude", inputTokens: 10, outputTokens: 4, cacheReadTokens: 7, cacheCreationTokens: 2, costUsd: 0.25, durationMs: 1200 });
  const codex = normalizeUsage("codex", { usage: { prompt_tokens: 3, completion_tokens: 2 } });
  assert.equal(codex.inputTokens, 3);
  assert.equal(codex.outputTokens, 2);
});

test("rejects unknown providers, junk shapes and negative or non-finite numbers", () => {
  assert.equal(normalizeUsage("gpt", { usage: { input_tokens: 1 } }), null);
  assert.equal(normalizeUsage("claude", null), null);
  assert.equal(normalizeUsage("claude", [1]), null);
  assert.equal(normalizeUsage("claude", { usage: { input_tokens: -5, output_tokens: NaN }, total_cost_usd: Infinity }), null);
});

test("ledger totals per provider and per task, persists atomically, and survives a corrupt file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-usage-"));
  const ledger = await new UsageLedger({ storageRoot: dir }).load();
  ledger.record("t1", "claude", normalizeUsage("claude", { usage: { input_tokens: 10, output_tokens: 1 }, total_cost_usd: 0.1 }));
  ledger.record("t1", "claude", normalizeUsage("claude", { usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.2 }));
  ledger.record("t2", "codex", normalizeUsage("codex", { usage: { input_tokens: 8, output_tokens: 2 } }));
  assert.equal(ledger.record("t2", "claude", null), null);
  await ledger.flush();

  const s = ledger.summary({ taskId: "t1" });
  assert.equal(s.byProvider.claude.calls, 2);
  assert.equal(s.byProvider.claude.inputTokens, 15);
  assert.ok(Math.abs(s.byProvider.claude.costUsd - 0.3) < 1e-9);
  assert.equal(s.byProvider.codex.calls, 1);
  assert.equal(s.task.claude.calls, 2);
  assert.equal(s.task.codex.calls, 0);

  const reloaded = await new UsageLedger({ storageRoot: dir }).load();
  assert.equal(reloaded.summary().byProvider.claude.inputTokens, 15);
  assert.equal(fs.existsSync(path.join(dir, "usage-ledger.json.tmp")), false);

  fs.writeFileSync(path.join(dir, "usage-ledger.json"), "{not json");
  const fresh = await new UsageLedger({ storageRoot: dir }).load();
  assert.equal(fresh.summary().byProvider.claude.calls, 0);
});
