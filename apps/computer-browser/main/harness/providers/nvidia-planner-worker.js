"use strict";
const { NvidiaPlannerBridge } = require("./nvidia-planner-bridge");
const { DEFAULT_NVIDIA_MODEL, isNvidiaModel } = require("./nvidia-models");
const { createWorkerLoop } = require("./claude-code-worker");
function parseNvidiaWorkerArgs(argv) {
  if (!argv.length) return { model: DEFAULT_NVIDIA_MODEL };
  if (argv.length === 2 && argv[0] === "--model" && isNvidiaModel(argv[1])) return { model: argv[1] };
  throw new Error("invalid NVIDIA model arguments");
}
function main() {
  let bridge;
  try { bridge = new NvidiaPlannerBridge(parseNvidiaWorkerArgs(process.argv.slice(2))); }
  catch { process.stderr.write("[nvidia-planner] check NVIDIA_API_KEY and model selection\n"); process.exitCode = 2; return; }
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await bridge.close(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  createWorkerLoop({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, bridge }).on("close", shutdown);
}
if (require.main === module) main();
module.exports = { parseNvidiaWorkerArgs };
