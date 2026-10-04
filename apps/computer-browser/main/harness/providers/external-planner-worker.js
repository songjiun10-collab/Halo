"use strict";
const { createWorkerLoop } = require("./claude-code-worker");
const { ExternalPlannerBridge, EXTERNAL_MODELS } = require("./external-planner-bridge");

function parseExternalWorkerArgs(provider, argv) {
  if (!Object.hasOwn(EXTERNAL_MODELS, provider)) throw new Error("unknown planner provider");
  if (argv.length === 0) return { model: EXTERNAL_MODELS[provider] };
  if (argv.length === 2 && argv[0] === "--model" && argv[1] === EXTERNAL_MODELS[provider]) return { model: argv[1] };
  throw new Error("worker accepts only an allowlisted model; fast mode is unsupported");
}
function main(provider) {
  let bridge;
  try {
    const options = parseExternalWorkerArgs(provider, process.argv.slice(2));
    const key = provider === "cursor" ? "CURSOR_API_KEY" : "GEMINI_API_KEY";
    if (!process.env[key]) throw new Error(`${key} is required; desktop login is not inherited`);
    bridge = new ExternalPlannerBridge({ provider, ...options,
      command: process.env[provider === "cursor" ? "HALO_CURSOR_CLI_COMMAND" : "HALO_ANTIGRAVITY_CLI_COMMAND"] });
  } catch (error) {
    process.stderr.write(`[${provider}-planner] ${error.message}\n`); process.exitCode = 2; return;
  }
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await bridge.close(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  const loop = createWorkerLoop({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, bridge });
  loop.on("close", shutdown);
}
module.exports = { main, parseExternalWorkerArgs };
