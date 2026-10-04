"use strict";

// Codex CLI planner worker: the same JSONL protocol and loop as
// claude-code-worker.js, with CodexPlannerBridge behind it.

const fs = require("node:fs");
const { createWorkerLoop } = require("./claude-code-worker");
const { CodexPlannerBridge } = require("./codex-planner-bridge");
const { DEFAULT_CODEX_MODEL, isCodexModel } = require("./codex-models");

// No argv or exactly `--model <allowlisted Codex id>`, optionally followed by
// `--fast`; anything else is refused.
function parseCodexWorkerArgs(argv) {
  const fast = argv.length > 0 && argv[argv.length - 1] === "--fast";
  const rest = fast ? argv.slice(0, -1) : argv;
  if (rest.length === 0) return { model: DEFAULT_CODEX_MODEL, fast };
  if (rest.length === 2 && rest[0] === "--model" && isCodexModel(rest[1])) return { model: rest[1], fast };
  throw new Error("worker accepts only [--model <allowlisted Codex model>] [--fast]");
}

// The ChatGPT app ships a newer Codex CLI than a standalone install usually
// is; older CLIs are refused the newest models by the server.
const BUNDLED_CODEX_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

function resolveCodexCommand(env = process.env, exists = fs.existsSync) {
  if (env.HALO_CODEX_CLI_COMMAND) return env.HALO_CODEX_CLI_COMMAND;
  return exists(BUNDLED_CODEX_CLI) ? BUNDLED_CODEX_CLI : "codex";
}

function main() {
  let model;
  let fast;
  try {
    ({ model, fast } = parseCodexWorkerArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[codex-planner-worker] ${error.message}\n`);
    process.exit(2);
  }
  const bridge = new CodexPlannerBridge({ command: resolveCodexCommand(), model, fast });
  // Reap the codex child (and remove the temp work dir) before exiting.
  const shutdown = async () => {
    try {
      await bridge.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });
  createWorkerLoop({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, bridge });
}

if (require.main === module) {
  main();
}

module.exports = { BUNDLED_CODEX_CLI, parseCodexWorkerArgs, resolveCodexCommand };
