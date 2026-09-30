"use strict";

// Selects the command (and env) used to spawn a planner worker process.
// Kept in its own module -- not inline in main/index.js -- so it can be
// unit tested without an Electron runtime: main/index.js requires
// "electron" at module load time, which only resolves when the process was
// actually launched via the Electron binary.
//
// Priority:
//   1. HALO_PLANNER_COMMAND (explicit host override, always wins)
//   2. HALO_NODE_COMMAND (explicit host override, second priority)
//   3. A real, verified `node` binary found on PATH, if one exists --
//      lighter and faster to cold-start than re-launching this Electron
//      binary in ELECTRON_RUN_AS_NODE mode (measured: a fresh
//      PlannerStdioAdapter child pays ~140-195ms on the Electron-as-node
//      path per spawn). No shell is ever invoked to find or verify it: PATH
//      is split on the platform delimiter, each candidate is checked with
//      fs.accessSync, and the candidate is confirmed to actually be Node by
//      running it with `--version` via execFileSync (argv array, no shell)
//      rather than trusting the filename alone.
//   4. Fallback: this Electron binary's own execPath with
//      ELECTRON_RUN_AS_NODE=1 -- the original, always-available default.
//
// The caller (main/index.js) resolves this ONCE per app lifetime (not once
// per planner instance / per task / per context reset) and reuses the
// result -- resolution itself may spawn a short-lived verification process,
// and redoing that on every task would add back exactly the kind of
// per-task process-spawn overhead this exists to reduce.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const NODE_VERSION_RE = /^v\d+\.\d+\.\d+/;

function looksLikeRealNode(candidate, { execFileSyncFn = execFileSync } = {}) {
  try {
    const out = execFileSyncFn(candidate, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    return NODE_VERSION_RE.test(String(out).trim());
  } catch {
    return false;
  }
}

function findRealNodeBinary({ pathEnv = process.env.PATH || "", accessSync = fs.accessSync, verify = looksLikeRealNode } = {}) {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "node");
    try {
      accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue; // not present/executable here; try the next PATH entry
    }
    if (verify(candidate)) return candidate;
    // Present but failed verification (not really Node, e.g. a decoy or an
    // unrelated tool sharing the name) -- keep looking down PATH instead of
    // trusting the filename.
  }
  return null;
}

function resolvePlannerCommand({ env = process.env, execPath = process.execPath, findNode = findRealNodeBinary } = {}) {
  if (env.HALO_PLANNER_COMMAND) {
    return { command: env.HALO_PLANNER_COMMAND, env: {} };
  }
  if (env.HALO_NODE_COMMAND) {
    return { command: env.HALO_NODE_COMMAND, env: {} };
  }
  const realNode = findNode({ pathEnv: env.PATH || "" });
  if (realNode) {
    return { command: realNode, env: {} };
  }
  return { command: execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

module.exports = { findRealNodeBinary, looksLikeRealNode, resolvePlannerCommand };
