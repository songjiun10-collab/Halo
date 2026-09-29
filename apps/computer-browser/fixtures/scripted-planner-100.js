"use strict";

// Deterministic protocol-only planner for long-horizon-100-site.js.
// This validates durable harness mechanics; it is not language-model quality.

const readline = require("node:readline");
// Optional read-only workload: scroll each non-final page this many times
// (distinct amounts, up to 3 per proposal) before following "Next". Progress is
// derived from the host's actionsUsed budget, not worker state, so a proposal
// the controller only partly dispatched (e.g. per-action review) is resumed
// correctly on the next call.
const SCROLLS_PER_PAGE = Number(process.env.HALO_BENCH_SCROLLS_PER_PAGE || 0);

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { requestId, context } = request || {};
  if (typeof requestId !== "string" || !context) return;
  const observation = context.observation || {};
  const goal = context.goal || {};
  const criterionId = goal.criteria?.[0]?.id || "C1";
  const text = [observation.text || "", ...(observation.elements || []).map((item) => item.name || "")].join(" ");
  const base = {
    taskId: context.taskId,
    goalVersion: context.goalVersion,
    basedOnObservationId: observation.id || "unknown-observation",
    criterionIds: [criterionId],
  };
  let proposal;
  if (/CHAIN-DONE-\d+/.test(text)) {
    proposal = { ...base, kind: "finish", evidenceIds: [] };
  } else {
    const next = (observation.elements || []).find((item) => item.role === "link" && item.name === "Next");
    const actionsUsed = context.progress?.budgets?.actionsUsed ?? 0;
    const done = actionsUsed >= 1 ? (actionsUsed - 1) % (SCROLLS_PER_PAGE + 1) : SCROLLS_PER_PAGE;
    if (next && done < SCROLLS_PER_PAGE) {
      const count = Math.min(3, SCROLLS_PER_PAGE - done);
      const actions = Array.from({ length: count }, (_, index) => ({ type: "scroll", direction: "down", amount: 200 + 100 * (done + index) }));
      proposal = { ...base, kind: "actions", actions };
    } else if (next) {
      proposal = { ...base, kind: "actions", actions: [{ type: "follow_link", elementId: next.elementId }] };
    } else if (!observation.url || observation.url === "about:blank") {
      const match = String(goal.originalRequest || "").match(/https?:\/\/\S+/);
      proposal = match
        ? { ...base, kind: "actions", actions: [{ type: "navigate", url: match[0] }] }
        : { ...base, kind: "need_user", reason: "initial URL missing" };
    } else {
      proposal = { ...base, kind: "need_user", reason: "expected Next link or final marker" };
    }
  }
  process.stdout.write(`${JSON.stringify({ requestId, proposal })}\n`);
});
