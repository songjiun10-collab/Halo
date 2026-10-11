"use strict";

// TEMPORARY measurement probe. Separates INPUT SIZE from MODEL REASONING as the
// cost of one real planner call.
//
//   node integration/probe-planner-latency.js [model]
//
// It runs the real CodexPlannerBridge (the same one TaskHost uses) with the real
// buildPrompt output, at two context sizes, and times each. The point is a
// controlled comparison, not a benchmark of any model's quality.
//
// THIS SPENDS REAL MODEL QUOTA. Four calls total. Do not loop it.
//
// What it can show: whether halving the per-turn context measurably changes
// latency. What it cannot show: task success, or where inside the model the time
// goes (reasoning tokens are not reported by the provider).

const { performance } = require("node:perf_hooks");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { buildContext } = require("../main/harness/context-builder");
const { CodexPlannerBridge } = require("../main/harness/providers/codex-planner-bridge");
const { DEFAULT_CODEX_MODEL } = require("../main/harness/providers/codex-models");

const MODEL = process.argv[2] || process.env.HALO_PROBE_MODEL || DEFAULT_CODEX_MODEL;

function makeObservation({ elements, textLines }) {
  return {
    id: "obs-1", documentEpoch: 1, url: "http://127.0.0.1:8081/", title: "Probe page",
    text: Array.from({ length: textLines }, (_, i) => `Item ${i}: paragraph body with readable content for item number ${i}.`).join("\n"),
    elements: Array.from({ length: elements }, (_, i) => ({
      elementId: String(i), parentElementId: null, role: i % 3 === 0 ? "link" : "button",
      name: `Item ${i} action`, text: `Item ${i}`,
    })),
    at: Date.now(),
  };
}

async function runOne(store, label, shape, bridge, turn) {
  const observation = makeObservation(shape);
  const context = buildContext({
    goal: store.getGoal(),
    state: { budgets: { plannerCallsUsed: turn, actionsUsed: turn, maxPlannerCalls: 25 } },
    navigation: { visited: [observation.url], frontier: [] },
    observation, recentEvents: [],
  });
  const contextBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
  const startedAt = performance.now();
  let usage = null;
  let outcome;
  try {
    const result = await bridge.start(context, { signal: undefined, attachments: [] });
    usage = result?.usage ?? null;
    outcome = "ok";
  } catch (error) {
    outcome = `error: ${String(error?.message ?? error).slice(0, 120)}`;
  }
  const elapsed = performance.now() - startedAt;
  console.log(`${label.padEnd(26)} ctx=${String(contextBytes).padStart(6)}B  in=${String(usage?.inputTokens ?? "-").padStart(6)}  cached=${String(usage?.cacheReadTokens ?? "-").padStart(6)}  out=${String(usage?.outputTokens ?? "-").padStart(5)}  ${Math.round(elapsed).toString().padStart(6)}ms  ${outcome}`);
  return { contextBytes, elapsed, usage };
}

async function main() {
  if (!MODEL) throw new Error("no codex model available");
  console.log(`model: ${MODEL}\n`);

  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-planner-probe-"));
  const store = await TaskStore.create({
    originalRequest: "Report the title of the third item on the page.",
    criteria: [{ id: "c1", text: "reported the third item", required: true, verification: "host" }],
    limits: { maxActions: 50, maxPlannerCalls: 25, maxActiveMs: 180000 },
  }, { storageRoot });

  const bridge = new CodexPlannerBridge({ model: MODEL, fast: false });
  const small = { elements: 10, textLines: 8 };
  const large = { elements: 100, textLines: 200 }; // 100 elements is the adapter's cap

  // Interleave so a transient slowdown cannot land on one shape only.
  const results = [];
  for (let round = 0; round < 2; round += 1) {
    results.push(await runOne(store, `round ${round} small`, small, bridge, round * 2));
    results.push(await runOne(store, `round ${round} large`, large, bridge, round * 2 + 1));
  }

  await bridge.close();
  await store.close();
  await fs.rm(storageRoot, { recursive: true, force: true });

  const s = results.filter((r) => r.label ?? true).filter((_, i) => i % 2 === 0);
  const l = results.filter((_, i) => i % 2 === 1);
  const mean = (xs) => xs.reduce((a, b) => a + b.elapsed, 0) / xs.length;
  const meanTok = (xs, k) => {
    const v = xs.map((x) => x.usage?.[k]).filter((n) => typeof n === "number");
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  console.log(`\nsmall mean: ${Math.round(mean(s))}ms   context ${Math.round(s.reduce((a, b) => a + b.contextBytes, 0) / s.length)}B   in ${meanTok(s, "inputTokens")} tok`);
  console.log(`large mean: ${Math.round(mean(l))}ms   context ${Math.round(l.reduce((a, b) => a + b.contextBytes, 0) / l.length)}B   in ${meanTok(l, "inputTokens")} tok`);
  console.log(`delta: ${Math.round(mean(l) - mean(s))}ms for ~${(l.reduce((a, b) => a + b.contextBytes, 0) / l.length) - (s.reduce((a, b) => a + b.contextBytes, 0) / s.length)} extra context bytes`);
  console.log("\nFour calls, one machine, one model. Not a benchmark of model quality or of a real task.");
}

main().then(() => process.exit(0), (error) => { console.error(error?.stack ?? error); process.exit(1); });