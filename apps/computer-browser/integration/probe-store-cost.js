"use strict";

// TEMPORARY measurement probe. Measures the durable TaskStore cost a real turn
// pays -- journal append (write + fsync) and checkpoint (write + fsync + rename +
// directory fsync) -- using the store's own onTiming labels. Pure node, no
// Electron, no Chromium, no model: fast and repeatable.
//
//   node integration/probe-store-cost.js [turns]
//
// This measures HOST cost only. It says nothing about planner latency or page
// load, which dominate a real turn's wall time.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");

const TURNS = Number(process.argv[2]) || 40;

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))];
  return {
    count: sorted.length,
    p50: +at(0.5).toFixed(3),
    p95: +at(0.95).toFixed(3),
    max: +sorted.at(-1).toFixed(3),
    total: +values.reduce((a, b) => a + b, 0).toFixed(1),
  };
}

const GOAL = {
  originalRequest: "Measure the durable store cost of one harness turn.",
  criteria: [{ id: "done", text: "measured", required: true, verification: "host" }],
  limits: { maxActions: 1000, maxPlannerCalls: 1000, maxActiveMs: 60 * 60 * 1000 },
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-store-cost-"));
  const samples = Object.create(null);
  const record = ({ operation, elapsedMs }) => {
    (samples[operation] ??= []).push(elapsedMs);
  };

  const store = await TaskStore.create(GOAL, { storageRoot: root, onTiming: record });

  // One turn's worth of durable work, repeated. Mirrors what TaskController does
  // per turn: several journal appends plus a checkpoint.
  const wall = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const startedAt = performance.now();
    await store.append({ type: "note", payload: { msg: `turn ${turn} observation` } });
    await store.append({ type: "note", payload: { msg: `turn ${turn} proposal` } });
    await store.append({ type: "note", payload: { msg: `turn ${turn} action` } });
    await store.checkpoint({ task: { state: "running", pauseReason: null }, turn });
    wall.push(performance.now() - startedAt);
  }
  await store.close();

  const labels = Object.keys(samples).sort();
  console.log(`turns: ${TURNS}   storageRoot: ${root}\n`);
  console.log("label                          count      p50      p95      max     total");
  for (const label of labels) {
    const s = stats(samples[label]);
    console.log(`${label.padEnd(28)} ${String(s.count).padStart(6)} ${String(s.p50).padStart(8)} ${String(s.p95).padStart(8)} ${String(s.max).padStart(8)} ${String(s.total).padStart(9)}`);
  }
  const w = stats(wall);
  console.log(`${"".padEnd(28)} ${String(w.count).padStart(6)} ${String(w.p50).padStart(8)} ${String(w.p95).padStart(8)} ${String(w.max).padStart(8)} ${String(w.total).padStart(9)}   <- one full turn`);

  const fsyncs = (samples.journal_fsync ?? []).length + (samples.checkpoint_file_fsync ?? []).length
    + (samples.checkpoint_directory_fsync ?? []).length;
  const fsyncTotal = [...(samples.journal_fsync ?? []), ...(samples.checkpoint_file_fsync ?? []),
    ...(samples.checkpoint_directory_fsync ?? [])].reduce((a, b) => a + b, 0);
  console.log(`\nfsync calls per turn: ${(fsyncs / TURNS).toFixed(1)}   fsync ms per turn: ${(fsyncTotal / TURNS).toFixed(2)}`);
  console.log(`durable host cost per turn: p50 ${w.p50}ms  p95 ${w.p95}ms`);

  await fs.rm(root, { recursive: true, force: true });
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });