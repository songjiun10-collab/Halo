#!/usr/bin/env node
"use strict";

// Runs Online-Mind2Web-style tasks against a Halo background service
// (`electron . --halo-background-service`) and records how each one ended.
// It never confirms a criterion: a task that reaches awaiting_verification
// is counted as "finished", and grading is left to a person or a separate
// grader reading the journal.
//
// Usage: node tools/bench-runner.js <tasks.json> <out.jsonl> [--timeout 600] [--limit 20]
// tasks.json: [{ "task_id", "level", "task", "website" }]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { BackgroundRuntimeClient } = require("../main/harness/background-runtime-client");

const RUNTIME_DIR = path.join(os.homedir(), "Library/Application Support/halo-computer-browser/background-runtime");
const SETTLED = new Set(["awaiting_verification", "completed", "stopped"]);
const PAUSE_GIVE_UP = new Set(["memory_pressure", "memory_emergency", "need_user", "goal_not_reached", "captcha", "planner_error", "planner_unavailable"]);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTask(client, item, timeoutMs) {
  const started = Date.now();
  const created = await client.createTask({ originalRequest: item.website ? `${item.task}\nStart at ${item.website}` : item.task });
  const taskId = created.taskId;
  let snapshot = created.snapshot ?? {};
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    ({ snapshot } = await client.getTaskDetail(taskId));
    if (!snapshot) continue;
    if (SETTLED.has(snapshot.state)) break;
    if (snapshot.state === "paused" && PAUSE_GIVE_UP.has(snapshot.pauseReason)) break;
  }
  const timedOut = !snapshot || !(SETTLED.has(snapshot.state) || snapshot.state === "paused");
  // A settled or paused task still holds the single active queue slot, so end
  // it after reading the result; the journal stays for grading.
  const final = { state: timedOut ? "timeout" : snapshot.state, pauseReason: snapshot?.pauseReason ?? null };
  if (final.state !== "completed") await client.stopTask(taskId).catch(() => {});
  return {
    task_id: item.task_id, level: item.level, halo_task_id: taskId,
    state: timedOut ? "timeout" : snapshot.state, pauseReason: snapshot?.pauseReason ?? null,
    durationMs: Date.now() - started,
    // For an information task the planner's answer arrives as need_user.
    answer: snapshot?.needUserReason ?? snapshot?.finalAnswer ?? snapshot?.summary ?? snapshot?.resultSummary ?? null,
  };
}

async function main() {
  const [tasksFile, outFile] = process.argv.slice(2);
  if (!tasksFile || !outFile) throw new Error("usage: bench-runner.js <tasks.json> <out.jsonl> [--timeout s] [--limit n]");
  const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8")).slice(0, arg("limit", Infinity));
  const timeoutMs = arg("timeout", 600) * 1000;
  const capability = fs.readFileSync(path.join(RUNTIME_DIR, "capability"), "utf8").trim();
  const client = new BackgroundRuntimeClient({
    socketPath: path.join(RUNTIME_DIR, "ipc", "runtime.sock"),
    capability,
    clientId: `bench-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  });
  await client.connect();
  try {
    for (const item of tasks) {
      const row = await runTask(client, item, timeoutMs).catch((error) => ({ task_id: item.task_id, level: item.level, state: "error", error: error.code || error.message }));
      fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
      console.log(row.task_id.slice(0, 8), row.level, row.state, row.pauseReason ?? "", row.durationMs ?? "");
    }
  } finally {
    await client.detach();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
