#!/usr/bin/env node
"use strict";

// One command for a benchmark round. It starts Halo as a headless background
// service, applies the bench settings, runs tools/bench-runner.js, then puts
// the host settings back and stops the service, even if the run fails.
//
//   node tools/bench.js <tasks.json> <out.jsonl> [--limit 20] [--timeout 300]
//        [--provider codex_cli] [--model gpt-6-luna] [--mode full] [--payments] [--assist]
//
// Safety rules stay on in a benchmark. --payments only turns on the opt-in so a task that clearly
// orders a purchase (one site, one limit, in the request text) can run; it is switched back off
// afterwards. Tasks that hit a card field, a password or an uncovered payment click pause with
// need_user or an approval, and show up as such in the summary.
//
// Made-up shop for checkout rounds (no real site, person or card): start it first with
//   node fixtures/fake-shop-server.js &
// then run with fixtures/fake-shop-tasks.json. The agent still never types the card: the card
// task ends as need_user, or with --assist a person types the public test number
// 4242 4242 4242 4242 into the page. Check what was ordered with: curl localhost:8099/__orders
//
// Close the normal Halo window first: both use the same user data directory.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { BackgroundRuntimeClient } = require("../main/harness/background-runtime-client");

const APP_DIR = path.join(__dirname, "..");
const RUNTIME_DIR = path.join(os.homedir(), "Library/Application Support/halo-computer-browser/background-runtime");
const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const capabilityPath = path.join(RUNTIME_DIR, "capability");
  for (let i = 0; i < 60; i += 1) {
    if (fs.existsSync(capabilityPath)) {
      const client = new BackgroundRuntimeClient({
        socketPath: path.join(RUNTIME_DIR, "ipc/runtime.sock"),
        capability: fs.readFileSync(capabilityPath, "utf8").trim(),
        clientId: `bench-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
      });
      try { await client.connect(); return client; } catch { /* service still starting */ }
    }
    await sleep(1000);
  }
  throw new Error("background service did not come up");
}

function summarize(outFile) {
  const rows = fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const by = {};
  for (const r of rows) { const k = r.pauseReason ? `${r.state}/${r.pauseReason}` : r.state; by[k] = (by[k] || 0) + 1; }
  console.log(`\n${rows.length} tasks:`, by);
}

async function main() {
  const [tasksFile, outFile] = process.argv.slice(2);
  if (!tasksFile || !outFile) throw new Error("usage: bench.js <tasks.json> <out.jsonl> [--limit n] [--timeout s] [--provider id] [--model id] [--mode full] [--payments]");
  spawnSync("pkill", ["-f", "computer-browser/node_modules"]);
  await sleep(2000);
  const log = fs.openSync(flag("service-log", "/tmp/halo-bench-service.log"), "w");
  const service = spawn("npm", ["start", "--", "--halo-background-service"], {
    cwd: APP_DIR, stdio: ["ignore", log, log], detached: true, env: { ...process.env, HALO_DEBUG_ACTIONS: "1" },
  });
  service.unref();
  const client = await connect();
  const before = await client.getHostSettings();
  try {
    await client.updateHostSettings({
      permissionMode: flag("mode", "full"),
      ...(flag("provider") ? { plannerProvider: flag("provider") } : {}),
      ...(flag("model") ? { plannerModel: flag("model") } : {}),
      ...(process.argv.includes("--payments") ? { paymentsEnabled: true } : {}),
    });
    const run = spawnSync("node", [path.join(__dirname, "bench-runner.js"), tasksFile, outFile,
      "--timeout", flag("timeout", "300"), ...(process.argv.includes("--assist") ? ["--assist"] : []), ...(flag("limit") ? ["--limit", flag("limit")] : [])], { cwd: APP_DIR, stdio: "inherit" });
    if (run.status !== 0) console.error("runner exited with", run.status);
  } finally {
    await client.updateHostSettings({
      permissionMode: before.permissionMode, plannerProvider: before.plannerProvider, plannerModel: before.plannerModel,
      paymentsEnabled: before.paymentsEnabled === true,
    }).catch((error) => console.error("settings were NOT restored:", error.code || error.message, JSON.stringify(before)));
    await client.stopService?.().catch(() => {});
    await client.detach().catch(() => {});
    const stale = path.join(os.tmpdir(), `halo-background-runtime-${Date.now()}`);
    if (fs.existsSync(RUNTIME_DIR)) fs.renameSync(RUNTIME_DIR, stale);
  }
  if (fs.existsSync(outFile)) summarize(outFile);
}

main().catch((error) => { console.error(error); process.exit(1); });
