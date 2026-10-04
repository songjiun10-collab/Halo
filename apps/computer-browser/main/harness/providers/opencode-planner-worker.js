"use strict";

const { createWorkerLoop } = require("./claude-code-worker");
const { OpenCodePlannerBridge, MODEL_ID } = require("./opencode-planner-bridge");

function parseOpenCodeWorkerArgs(argv) {
  if (argv.length === 0) return { model: MODEL_ID };
  if (argv.length === 2 && argv[0] === "--model" && argv[1] === MODEL_ID) return { model: MODEL_ID };
  throw new Error("worker accepts only the host-pinned OpenCode default model; fast mode is unsupported");
}

function main() {
  let bridge;
  try {
    const { model } = parseOpenCodeWorkerArgs(process.argv.slice(2));
    bridge = new OpenCodePlannerBridge({ model });
  } catch (error) {
    process.stderr.write(`[opencode-planner] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await bridge.close(); } finally { process.exit(0); }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  createWorkerLoop({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, bridge }).on("close", shutdown);
}

if (require.main === module) main();
module.exports = { parseOpenCodeWorkerArgs, main };
