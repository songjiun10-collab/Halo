"use strict";

// The actual process planner-stdio.js's PlannerStdioAdapter spawns when an
// operator points HALO_PLANNER_COMMAND/HALO_PLANNER_ARGS at this file (see
// README.ko.md). Speaks the exact JSONL protocol PlannerStdioAdapter already
// expects: one `{requestId, context}` line in on stdin, one
// `{requestId, proposal}` line out on stdout per request -- no new wire
// format, so PlannerStdioAdapter's existing frame-size cap, timeout,
// one-in-flight enforcement, and wrong/late-requestId rejection all apply
// here unmodified.
//
// There is no error frame in that protocol (no planner -- scripted, fake, or
// this one -- has ever had one), so a failed request here is deliberately
// left unanswered: nothing is written for that requestId, and the failure is
// only logged to stderr (planner-stdio.js already captures a bounded tail of
// it for diagnostics). PlannerStdioAdapter's existing 60s response timeout
// then surfaces this exactly like any other broken/slow planner would --
// task-controller.js pauses with pauseReason "planner_error". This is a
// deliberate reuse of an existing safety path, not a gap: adding a bespoke
// error frame here would be a new wire contract PlannerStdioAdapter was never
// built to parse.
//
// This file has no direct dependency on Electron, the durable journal, or
// the approver -- createWorkerLoop() is exercised directly (fake stdin/
// stdout/bridge) by claude-code-worker.test.js without spawning a real
// process or invoking the real claude CLI.

const readline = require("node:readline");
const { ClaudeCodeBridge } = require("./claude-code-bridge");

function createWorkerLoop({ stdin, stdout, stderr, bridge }) {
  const rl = readline.createInterface({ input: stdin, terminal: false });

  rl.on("line", (line) => {
    if (!line.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      stderr.write("[claude-code-worker] dropping unparseable request line\n");
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.requestId !== "string") {
      stderr.write("[claude-code-worker] dropping request line missing requestId\n");
      return;
    }

    const { requestId, context } = parsed;
    Promise.resolve()
      .then(() => bridge.start(context))
      .then((proposal) => {
        const usage = typeof bridge.takeUsage === "function" ? bridge.takeUsage() : null;
        stdout.write(`${JSON.stringify(usage ? { requestId, proposal, usage } : { requestId, proposal })}\n`);
      })
      .catch((error) => {
        stderr.write(`[claude-code-worker] request ${requestId} failed: ${(error && error.message) || error}\n`);
      });
  });

  return rl;
}

function main() {
  const bridge = new ClaudeCodeBridge({
    command: process.env.HALO_CLAUDE_CLI_COMMAND || "claude",
  });

  // If this worker process is killed while a claude CLI call is in flight,
  // cancel it AND wait for the OS to actually reap that child
  // (ClaudeCodeBridge.close() does both) before this process itself exits --
  // calling process.exit() right after cancel() would not prove the `claude`
  // subprocess is actually gone yet, and could orphan it still running
  // against the user's real claude account.
  const shutdown = async () => {
    try {
      await bridge.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => {
    shutdown();
  });
  process.on("SIGINT", () => {
    shutdown();
  });

  createWorkerLoop({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, bridge });
}

if (require.main === module) {
  main();
}

module.exports = { createWorkerLoop };
