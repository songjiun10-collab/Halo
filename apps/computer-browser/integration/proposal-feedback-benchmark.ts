"use strict";
// Offline ablation, not an LLM benchmark. The scripted planner can correct a
// stale goal only when supplied the host diagnostic. Both modes use the SAME
// real controller, limits and stores. Hidden mode removes only this diagnostic.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

async function run(mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-proposal-bench-"));
  let store: any;
  let controller: any;
  try {
    store = await TaskStore.create({ originalRequest: "controlled correction fixture" }, { storageRoot: root });
    let calls = 0, contextBytes = 0, feedbackBytes = 0, executed = 0;
    controller = new TaskController({ store, maxRecoveries: 0, hostVerifier: () => false,
      approve: async () => ({ decision: "allow", reasons: [] }),
      browser: { observe: async () => ({ id: "obs", url: "https://example.test/", elements: [] }),
        execute: async () => { executed++; return { status: "ok" }; } },
      planner: { next: async (context: any) => {
        const input = JSON.parse(JSON.stringify(context));
        if (mode === "feedback-hidden") delete input.progress.proposalFeedback;
        calls++;
        contextBytes += Buffer.byteLength(JSON.stringify(input));
        const feedback = input.progress.proposalFeedback;
        if (feedback) feedbackBytes += Buffer.byteLength(JSON.stringify(feedback));
        return { taskId: input.taskId,
          goalVersion: feedback?.code === "stale_goal_version" ? input.goalVersion : input.goalVersion + 1,
          basedOnObservationId: input.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] };
      } },
    });
    const start = performance.now();
    const state = await controller.start();
    const row = { mode, wallMs: performance.now() - start, calls, contextBytes, feedbackBytes,
      executed, state: state.state, pauseReason: state.pauseReason };
    if (calls !== 2 || executed !== 0 || state.budgets.plannerCallsUsed !== 2
      || (mode === "feedback-hidden" ? state.pauseReason !== "invalid_proposal" : state.state !== "awaiting_verification")) {
      throw new Error("ablation_fixture_diverged");
    }
    return row;
  } finally {
    await controller?.stop();
    await store?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const rows: any[] = [];
  for (let pair = 0; pair < 8; pair++) {
    for (const mode of pair % 2 ? ["feedback-visible", "feedback-hidden"] : ["feedback-hidden", "feedback-visible"]) {
      rows.push({ pair, ...await run(mode) });
    }
  }
  const summary = ["feedback-hidden", "feedback-visible"].map(mode => {
    const sample = rows.filter(row => row.mode === mode);
    const sorted = sample.map(row => row.wallMs).sort((a, b) => a - b);
    return { mode, count: sample.length, correctedProposals: sample.filter(row => row.state === "awaiting_verification").length,
      calls: sample.reduce((sum, row) => sum + row.calls, 0),
      meanContextBytes: sample.reduce((sum, row) => sum + row.contextBytes, 0) / sample.length,
      meanFeedbackBytes: sample.reduce((sum, row) => sum + row.feedbackBytes, 0) / sample.length,
      p50Ms: sorted[3], p95Ms: sorted[7], executedActions: sample.reduce((sum, row) => sum + row.executed, 0) };
  });
  process.stdout.write(JSON.stringify({ schemaVersion: 1, fixture: "scripted-stale-goal-feedback-ablation", summary,
    limits: ["No external model or web calls; proposal correction is scripted, not task success or model accuracy. Human C1 verification remains pending.",
      "Same current controller in both modes, NOT a historical-controller E2E comparison.",
      "Bytes are measured; tokens, model cost and model latency are not.",
      "Wall time includes local durable recording but excludes store creation and teardown."] }, null, 2) + "\n");
}
main().catch((error: Error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
