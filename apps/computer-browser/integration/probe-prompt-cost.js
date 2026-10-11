"use strict";

// TEMPORARY measurement probe. Decomposes the planner request into its parts so
// the per-call token cost can be attributed: fixed system prompt + tool schemas
// vs the per-turn context packet.
//
//   node integration/probe-prompt-cost.js
//
// The pilot numbers show ~10,400 input tokens per planner call against a ~20.5 KB
// context packet (~5k tokens), so roughly half the billed input is NOT the
// context packet. This finds out what the rest is and how big each part is.
//
// Byte counts are NOT tokens. Token counts are only reported by the provider; the
// chars/4 column below is a labelled estimate, never a measurement.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { buildContext } = require("../main/harness/context-builder");

const est = (s) => Math.round(s / 4);

async function main() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-prompt-cost-"));
  const store = await TaskStore.create({
    originalRequest: "Compare the two cheapest fares on the page and report which is cheaper.",
    criteria: [{ id: "done", text: "compared", required: true, verification: "host" }],
    limits: { maxActions: 50, maxPlannerCalls: 25, maxActiveMs: 180000 },
  }, { storageRoot });
  const goal = store.getGoal();

  // A page shaped like the probe's: 60 sections.
  const elements = Array.from({ length: 40 }, (_, i) => ({
    index: i, parentIndex: null, role: i % 3 === 0 ? "link" : "button",
    name: `Item ${i} action`, tag: i % 3 === 0 ? "a" : "button", text: `Item ${i}`,
  }));
  const observation = {
    id: "obs-1", documentEpoch: 1, url: "http://127.0.0.1:8081/", title: "Probe page",
    text: Array.from({ length: 60 }, (_, i) => `Item ${i}: paragraph body with readable content.`).join("\n"),
    elements, at: Date.now(),
  };

  const context = buildContext({
    goal, state: { budgets: { plannerCallsUsed: 3, actionsUsed: 3 } },
    navigation: { visited: [observation.url], frontier: [] },
    observation, recentEvents: [],
  });

  const parts = Object.fromEntries(Object.keys(context).map((k) => [k, Buffer.byteLength(JSON.stringify(context[k]), "utf8")]));
  const total = Buffer.byteLength(JSON.stringify(context), "utf8");
  const systemPromptPath = path.join(__dirname, "..", "main", "harness", "providers", "model-prompt-guidance.js");
  const guidanceBytes = await fs.readFile(systemPromptPath, "utf8").then((s) => Buffer.byteLength(s, "utf8")).catch(() => 0);
  const codexWorkerPath = path.join(__dirname, "..", "main", "harness", "providers", "codex-planner-worker.js");
  const workerBytes = await fs.readFile(codexWorkerPath, "utf8").then((s) => Buffer.byteLength(s, "utf8")).catch(() => 0);

  console.log("PLANNER REQUEST COMPOSITION (bytes, not tokens)\n");
  console.log("context packet total      ", String(total).padStart(8), ` ~${est(total)} tok est`);
  for (const [k, v] of Object.entries(parts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)}`, String(v).padStart(8), ` ${((v / total) * 100).toFixed(1).padStart(5)}%`);
  }
  console.log("\nreference file sizes (whole files; only part of each is prompt text):");
  console.log("  model-prompt-guidance.js ", String(guidanceBytes).padStart(8));
  console.log("  codex-planner-worker.js  ", String(workerBytes).padStart(8));

  console.log(`\nPilot cross-check: ~10,400 provider input tokens per call.`);
  console.log(`Context packet alone is ~${est(total)} tok est, so the remainder (~${10400 - est(total)} tok) is`);
  console.log("system prompt + tool schemas + conversation/tool-result history that the provider re-sends.");
  console.log("Token counts are provider-reported only; the est column assumes 4 chars/token and is not evidence.");

  await store.close();
  await fs.rm(storageRoot, { recursive: true, force: true });
}

main().then(() => process.exit(0), (error) => { console.error(error?.stack ?? error); process.exit(1); });