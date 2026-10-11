#!/usr/bin/env node
"use strict";

// Real-planner A/B for the hallucination-prevention text. Runs the accuracy
// suite twice against a hosted NVIDIA planner: once with the grounded-answer
// discipline in the playbooks (default) and once with
// HALO_GROUNDING_GUIDE_OFF=1. The controller's production grounding device is
// off inside the harness (run-suite), so the harness's own correction arm and
// its uncorrected `hallucinatedFirstAnswer` counter stay the measurement.
//
// Usage (from apps/computer-browser/):
//   NVIDIA_API_KEY=... node integration/accuracy/nvidia-grounding-ab.js
//   node integration/accuracy/nvidia-grounding-ab.js --check
//
// Options:
//   --provider nvidia|ollama   (default nvidia)
//   --model <id>            default nvidia/nemotron-3-super-120b-a12b (or llama3.1:8b for ollama)
//   --ollama-url <url>      default http://127.0.0.1:11434
//   --arm prevention-on|prevention-off|both   (default both)
//   --tasks a,b,c           default: the scored suite
//   --corrections <n>       harness correction arm, default 1
//   --include-control       add the two blocked control tasks
//   --out <dir>             where rows/summary JSON land (default: temp dir)
//   --no-store              do not fall back to the key registered in HALO
//
// Key resolution: NVIDIA_API_KEY first, then the key the user registered in
// HALO Settings, decrypted through the app's own keychain module. The value is
// never printed or written.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { runAccuracySuite } = require("./run-suite.ts");
const { NvidiaPlannerBridge } = require("../../main/harness/providers/nvidia-planner-bridge");
const { DEFAULT_NVIDIA_MODEL, isNvidiaModel, setDiscoveredNvidiaModels } = require("../../main/harness/providers/nvidia-models");
const { fetchNvidiaModelIds } = require("../../main/harness/nvidia-model-catalog");

const ARMS = Object.freeze(["prevention-on", "prevention-off"]);

function parseArgs(argv) {
  const options = { arm: "both", provider: "nvidia", model: DEFAULT_NVIDIA_MODEL, corrections: 1, tasks: undefined, includeControl: false, out: null, noStore: false, storageRoot: null, check: false, timeoutMs: 180_000, logRaw: null, ollamaUrl: "http://127.0.0.1:11434" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => { index += 1; return argv[index]; };
    if (token === "--arm") options.arm = next();
    else if (token === "--provider") options.provider = next();
    else if (token === "--model") options.model = next();
    else if (token === "--ollama-url") options.ollamaUrl = next();
    else if (token === "--tasks") options.tasks = String(next() ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    else if (token === "--corrections") options.corrections = Number(next());
    else if (token === "--timeout") options.timeoutMs = Number(next());
    else if (token === "--out") options.out = next();
    else if (token === "--storage-root") options.storageRoot = next();
    else if (token === "--log-raw") options.logRaw = next();
    else if (token === "--include-control") options.includeControl = true;
    else if (token === "--no-store") options.noStore = true;
    else if (token === "--check") options.check = true;
    else throw new Error(`unknown option ${token}`);
  }
  if (options.arm !== "both" && !ARMS.includes(options.arm)) throw new Error("--arm must be prevention-on|prevention-off|both");
  if (!["nvidia", "ollama"].includes(options.provider)) throw new Error("--provider must be nvidia|ollama");
  if (!Number.isInteger(options.corrections) || options.corrections < 0) throw new Error("--corrections must be a non-negative integer");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout must be a positive integer (ms per task)");
  return options;
}

async function resolveApiKey(options) {
  const fromEnv = typeof process.env.NVIDIA_API_KEY === "string" ? process.env.NVIDIA_API_KEY.trim() : "";
  if (fromEnv) return { key: fromEnv, source: "NVIDIA_API_KEY" };
  if (options.noStore) return { key: "", source: "not set (--no-store)" };
  try {
    const { createKeychainStorage } = require("../../main/harness/chromium-keychain");
    const { ApiKeyStore } = require("../../main/harness/api-key-store");
    const storageRoot = options.storageRoot || path.join(os.homedir(), "Library", "Application Support", "halo-computer-browser", "harness-data");
    const store = new ApiKeyStore({ storageRoot, safeStorage: createKeychainStorage() });
    await store.load();
    const key = store.env().NVIDIA_API_KEY ?? "";
    return { key, source: key ? "HALO Settings keychain" : "not registered" };
  } catch (error) {
    return { key: "", source: `keychain unavailable (${error?.code ?? error?.message ?? "error"})` };
  }
}

function summarize(arm, options, rows, summary) {
  return {
    arm,
    prevention: arm === "prevention-on",
    model: options.model,
    correctionsBudget: options.corrections,
    taskCount: rows.length,
    summary,
    counts: {
      pass: rows.filter((row) => row.verdict === "pass").length,
      fail: rows.filter((row) => row.verdict === "fail").length,
      blocked: rows.filter((row) => row.verdict === "blocked").length,
      inconclusive: rows.filter((row) => row.verdict === "inconclusive").length,
      hallucinatedFinal: rows.filter((row) => row.hallucinated).length,
      fabricatedFirstAnswer: rows.filter((row) => row.hallucinatedFirstAnswer).length,
      correctionTurns: rows.reduce((sum, row) => sum + (row.corrections ?? 0), 0),
      plannerCalls: rows.reduce((sum, row) => sum + (row.plannerCalls ?? 0), 0),
    },
    rows: rows.map((row) => ({
      taskId: row.taskId,
      verdict: row.verdict,
      reason: row.reason ?? null,
      ending: row.ending ?? null,
      pauseReason: row.pauseReason ?? null,
      blockReason: row.blockReason ?? null,
      hallucinated: row.hallucinated,
      hallucinatedFirstAnswer: row.hallucinatedFirstAnswer,
      corrections: row.corrections,
      unsupported: row.unsupported,
      answer: row.answer,
      plannerCalls: row.plannerCalls,
      wallMs: row.wallMs,
    })),
  };
}

function printTable(result) {
  console.log(`\n=== ${result.arm} (model ${result.model}, corrections ${result.correctionsBudget}) ===`);
  console.log("task                     verdict        final  first  corr  calls     ms");
  for (const row of result.rows) {
    console.log([
      String(row.taskId).padEnd(24),
      `${row.verdict}${row.blockReason ? `(${row.blockReason})` : ""}`.padEnd(14),
      (row.hallucinated ? "HALL" : "ok").padEnd(6),
      (row.hallucinatedFirstAnswer ? "yes" : "no").padEnd(6),
      String(row.corrections ?? 0).padEnd(5),
      String(row.plannerCalls ?? 0).padEnd(7),
      String(row.wallMs ?? 0),
    ].join(" "));
  }
  const c = result.counts;
  console.log(`totals: pass ${c.pass} · fail ${c.fail} · blocked ${c.blocked} · inconclusive ${c.inconclusive} | fabricatedFirstAnswer ${c.fabricatedFirstAnswer}/${result.taskCount} · hallucinatedFinal ${c.hallucinatedFinal}/${result.taskCount} · corrections ${c.correctionTurns}`);
  console.log(`summary: ${JSON.stringify(result.summary)}`);
}

function makeLoggingFetch(logFile) {
  let turn = 0;
  return async (url, init) => {
    const response = await globalThis.fetch(url, init);
    const clone = response.clone();
    Promise.resolve().then(async () => {
      try {
        const data = await clone.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text === "string") {
          turn += 1;
          fs.appendFileSync(logFile, `\n===== turn ${turn} =====\n${text.slice(0, 6000)}\n`);
        }
      } catch { /* logging must never disturb the run */ }
    });
    return response;
  };
}

// A catalog id is only usable when this account is provisioned for it; the
// built-in list is not the served set (Mistral and most of the discovered
// catalog answer 404 "not found for account"). The bridge accepts built-in ids
// and discovered ones, so load the account catalog for anything else and let
// the API call be the final gate.
async function ensureModelAvailable(apiKey, model) {
  if (isNvidiaModel(model)) return;
  let ids = [];
  try {
    ids = await fetchNvidiaModelIds({ apiKey });
  } catch (error) {
    throw new Error(`model ${model} is not built in and the hosted catalog could not be fetched (${error?.code ?? error?.message ?? error})`);
  }
  if (!ids.includes(model)) throw new Error(`model ${model} is not in this account's hosted catalog`);
  setDiscoveredNvidiaModels(ids);
}

// A local Ollama planner for the same harness: one OpenAI-compatible endpoint,
// the production prompt and the production proposal parser, so a local model is
// measured against the same contract as the hosted ones.
function makeOllamaPlanner({ model, url, logRaw }) {
  const endpoint = `${String(url).replace(/\/+$/, "")}/v1/chat/completions`;
  return {
    async next(context, nextOptions = {}) {
      const { buildPrompt, parseAndValidateProposal, stripCodeFence } = require("../../main/harness/providers/claude-code-bridge");
      const prompt = buildPrompt(context, null);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      nextOptions?.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch(endpoint, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 8192, stream: false }),
        });
        if (!response.ok) throw Object.assign(new Error(`ollama http ${response.status}`), { code: "http_error" });
        const data = await response.json();
        const text = stripCodeFence(String(data?.choices?.[0]?.message?.content ?? ""));
        if (logRaw) { try { fs.appendFileSync(logRaw, `\n===== turn =====\n${text.slice(0, 6000)}\n`); } catch { /* logging must never disturb the run */ } }
        return parseAndValidateProposal(text);
      } catch (error) {
        if (nextOptions?.signal?.aborted) throw Object.assign(new Error("ollama cancelled"), { code: "cancelled" });
        if (error?.name === "AbortError") throw Object.assign(new Error("ollama timeout"), { code: "timeout" });
        throw error;
      } finally {
        clearTimeout(timer);
        nextOptions?.signal?.removeEventListener("abort", cancel);
      }
    },
    async close() {},
  };
}

async function runArm(arm, options) {
  let plannerFactory;
  let source;
  if (options.provider === "ollama") {
    source = options.ollamaUrl;
    plannerFactory = () => makeOllamaPlanner({ model: options.model, url: options.ollamaUrl, logRaw: options.logRaw });
  } else {
    const resolved = await resolveApiKey(options);
    if (!resolved.key) throw new Error(`no NVIDIA key available (${resolved.source}); set NVIDIA_API_KEY or register the key in HALO Settings`);
    await ensureModelAvailable(resolved.key, options.model);
    source = `key=${resolved.source}`;
    const fetchFn = options.logRaw ? makeLoggingFetch(options.logRaw) : undefined;
    plannerFactory = () => {
      const bridge = new NvidiaPlannerBridge({ apiKey: resolved.key, model: options.model, ...(fetchFn ? { fetchFn } : {}) });
      return {
        next: (context, nextOptions) => bridge.start(context, nextOptions),
        close: () => bridge.close(),
      };
    };
  }
  process.stderr.write(`[ab] arm=${arm} provider=${options.provider} source=${source} model=${options.model} corrections=${options.corrections}\n`);
  const approve = async () => ({ decision: "allow", reasons: ["accuracy_fixture_scope"] });
  const { rows, summary } = await runAccuracySuite({
    taskIds: options.tasks,
    includeControl: options.includeControl,
    plannerFactory,
    approve,
    timeoutMs: options.timeoutMs,
    groundingCorrections: options.corrections,
  });
  return summarize(arm, options, rows, summary);
}

function runBoth(options) {
  const outDir = options.out || fs.mkdtempSync(path.join(os.tmpdir(), "halo-nvidia-ab-"));
  fs.mkdirSync(outDir, { recursive: true });
  for (const arm of ARMS) {
    const args = [__filename, "--arm", arm, "--provider", options.provider, "--model", options.model, "--corrections", String(options.corrections), "--timeout", String(options.timeoutMs), "--out", outDir];
    if (options.provider === "ollama") args.push("--ollama-url", options.ollamaUrl);
    if (options.tasks) args.push("--tasks", options.tasks.join(","));
    if (options.includeControl) args.push("--include-control");
    if (options.noStore) args.push("--no-store");
    if (options.storageRoot) args.push("--storage-root", options.storageRoot);
    args.push("--log-raw", path.join(outDir, `${arm}.raw.log`));
    const env = { ...process.env };
    if (arm === "prevention-off") env.HALO_GROUNDING_GUIDE_OFF = "1";
    else delete env.HALO_GROUNDING_GUIDE_OFF;
    const child = spawnSync(process.execPath, args, { stdio: "inherit", env });
    if (child.status !== 0) throw new Error(`arm ${arm} exited with ${child.status}`);
  }
  const results = ARMS.map((arm) => JSON.parse(fs.readFileSync(path.join(outDir, `${arm}.json`), "utf8")));
  const [on, off] = results;
  console.log("\n=== comparison ===");
  console.log("metric                     prevention-on   prevention-off");
  const line = (label, pick) => console.log(`${label.padEnd(26)} ${String(pick(on)).padEnd(15)} ${String(pick(off))}`);
  line("fabricatedFirstAnswer", (r) => `${r.counts.fabricatedFirstAnswer}/${r.taskCount}`);
  line("hallucinatedFinal", (r) => `${r.counts.hallucinatedFinal}/${r.taskCount}`);
  line("pass", (r) => `${r.counts.pass}/${r.taskCount}`);
  line("fail", (r) => `${r.counts.fail}/${r.taskCount}`);
  line("blocked", (r) => `${r.counts.blocked}/${r.taskCount}`);
  line("inconclusive", (r) => `${r.counts.inconclusive}/${r.taskCount}`);
  line("correctionTurns", (r) => r.counts.correctionTurns);
  line("plannerCalls", (r) => r.counts.plannerCalls);
  line("hallucinationRate", (r) => r.summary?.hallucinationRate ?? "n/a");
  line("passRate", (r) => r.summary?.passRate ?? "n/a");
  console.log(`\n[ab] JSON rows in ${outDir}`);
  console.log(`[ab] honest reading: this is one small suite (${on.taskCount} scored tasks); treat a difference as a signal to run more tasks, not as a verdict.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    if (options.provider === "ollama") {
      console.log(`provider   : ollama (${options.ollamaUrl})`);
      console.log(`model      : ${options.model}`);
      try {
        const tags = await fetch(`${options.ollamaUrl.replace(/\/+$/, "")}/api/tags`).then((response) => response.json());
        const names = (tags?.models ?? []).map((entry) => entry?.name).filter(Boolean);
        const present = names.includes(options.model) || names.includes(`${options.model}:latest`);
        console.log(`model      : ${present ? "present" : `NOT pulled (have: ${names.join(", ") || "none"})`}`);
        if (!present) process.exitCode = 1;
      } catch (error) {
        console.log(`ollama     : unreachable (${error?.message ?? error})`);
        process.exitCode = 1;
      }
      console.log(`tasks      : ${options.tasks ? options.tasks.join(",") : "(default scored suite)"}${options.includeControl ? " +control" : ""}`);
      return;
    }
    const { key, source } = await resolveApiKey(options);
    console.log(`key source : ${source}${key ? ` (${key.length} chars, not printed)` : ""}`);
    console.log(`model      : ${options.model}`);
    if (key) {
      try { await ensureModelAvailable(key, options.model); console.log("model      : available (built-in or account catalog)"); }
      catch (error) { console.log(`model      : ${error?.message ?? error}`); process.exitCode = 1; }
    }
    console.log(`tasks      : ${options.tasks ? options.tasks.join(",") : "(default scored suite)"}${options.includeControl ? " +control" : ""}`);
    if (!key) process.exitCode = 1;
    return;
  }
  if (options.arm === "both") return runBoth(options);
  const result = await runArm(options.arm, options);
  const outDir = options.out || fs.mkdtempSync(path.join(os.tmpdir(), "halo-nvidia-ab-"));
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${options.arm}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  printTable(result);
  console.log(`\n[ab] full rows written to ${file}`);
}

main().catch((error) => {
  console.error(`[ab] ${error?.message ?? error}`);
  process.exitCode = 1;
});
