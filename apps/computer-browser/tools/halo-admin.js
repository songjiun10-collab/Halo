#!/usr/bin/env node
"use strict";

// Operator tool for a beta: look at what the safety rules did, and flip the payment kill switch,
// without opening the app. It works on the app's data folder (the "harness-data" folder under the
// app's userData), so it needs a copy of or access to that folder.
//
//   halo-admin.js status   <dataRoot> [buildInfoFile]
//   halo-admin.js events   <dataRoot> [--since YYYY-MM-DD] [--kind payment_authorized,...]
//   halo-admin.js payments <dataRoot> on|off
//
// Writing note: the running app keeps its settings in memory. `payments off` here changes the file,
// which the app reads at its next start; to stop a running app right away use the Settings switch.
// Reading never changes anything. Journals hold no card numbers or typed secrets (they are masked
// before they are written), but they do hold task text: treat the output as private.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { HostSettingsStore } = require("../main/harness/host-settings");
const { readBuildInfo, checkBuild } = require("../main/harness/build-expiry");

// Journal notes that say a safety rule acted. Anything else in a journal is not the operator's business here.
const SAFETY_KINDS = Object.freeze([
  "payment_authorized", "payment_question", "card_input_blocked", "personal_input_blocked",
  "effect_denied", "research_answer_rejected", "research_answer_unverified_delivered",
]);

async function taskDirs(dataRoot) {
  const root = path.join(dataRoot, "tasks");
  let names;
  try { names = await fsp.readdir(root); } catch { return []; }
  return names.map((name) => path.join(root, name));
}

// Streams one journal; lines that are not valid JSON are counted, never fatal.
async function safetyEvents(journal, { since, kinds }) {
  const events = [];
  let bad = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(journal), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 1_000_000) { bad += 1; continue; }
      let event;
      try { event = JSON.parse(line); } catch { bad += 1; continue; }
      if (event?.type !== "note" || !kinds.includes(event.payload?.kind)) continue;
      if (since && String(event.at) < since) continue;
      events.push({ at: event.at, taskId: event.taskId, kind: event.payload.kind, detail: detail(event.payload) });
    }
  } catch { bad += 1; }
  return { events, bad };
}

// Only fields that explain the decision; never the whole payload.
function detail(payload) {
  const keep = ["origin", "currency", "amountMinor", "maxAmountMinor", "control", "tier", "actionType", "effect", "reason", "sites", "unopened"];
  const out = {};
  for (const key of keep) if (payload[key] !== undefined) out[key] = typeof payload[key] === "string" ? payload[key].slice(0, 120) : payload[key];
  return out;
}

async function collectEvents(dataRoot, { since, kinds = SAFETY_KINDS } = {}) {
  const all = [];
  let unreadable = 0;
  for (const dir of await taskDirs(dataRoot)) {
    const journal = path.join(dir, "events.jsonl");
    if (!fs.existsSync(journal)) continue;
    const { events, bad } = await safetyEvents(journal, { since, kinds });
    all.push(...events);
    unreadable += bad;
  }
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { events: all, unreadable };
}

async function status(dataRoot, buildInfoFile) {
  const settings = await new HostSettingsStore({ storageRoot: dataRoot }).load();
  const build = buildInfoFile ? checkBuild(readBuildInfo(buildInfoFile)) : null;
  const { events, unreadable } = await collectEvents(dataRoot);
  const counts = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;
  return {
    paymentsEnabled: settings.paymentsEnabled === true,
    permissionMode: settings.permissionMode,
    plannerProvider: settings.plannerProvider,
    build: build && { expired: build.expired, daysLeft: build.daysLeft, invalid: build.invalid === true },
    safetyCounts: counts,
    unreadableLines: unreadable,
  };
}

async function setPayments(dataRoot, value) {
  if (value !== "on" && value !== "off") throw new Error("payments takes on or off");
  const next = await new HostSettingsStore({ storageRoot: dataRoot }).update({ paymentsEnabled: value === "on" });
  return { paymentsEnabled: next.paymentsEnabled === true };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [command, dataRoot, ...rest] = argv;
  if (!command || !dataRoot) { console.error("usage: halo-admin.js status|events|payments <dataRoot> ..."); return 2; }
  if (command === "status") { console.log(JSON.stringify(await status(dataRoot, rest[0]), null, 2)); return 0; }
  if (command === "events") {
    const kinds = flag(rest, "--kind")?.split(",") ?? SAFETY_KINDS;
    const { events, unreadable } = await collectEvents(dataRoot, { since: flag(rest, "--since"), kinds });
    for (const e of events) console.log(`${e.at}  ${e.taskId}  ${e.kind}  ${JSON.stringify(e.detail)}`);
    if (unreadable) console.error(`${unreadable} journal line(s) could not be read`);
    return 0;
  }
  if (command === "payments") {
    console.log(JSON.stringify(await setPayments(dataRoot, rest[0])));
    console.log("Written to the settings file. A running app keeps its own copy: use the Settings switch to stop it now.");
    return 0;
  }
  console.error(`unknown command: ${command}`);
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });

module.exports = { collectEvents, status, setPayments, SAFETY_KINDS };
