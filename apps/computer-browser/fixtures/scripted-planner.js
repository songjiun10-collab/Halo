"use strict";

// Example JSONL stdio Planner worker (design doc section 6). This is a
// deterministic PROTOCOL fixture proving the transport works end to end
// with a real child process over real stdio pipes -- it is NOT a natural-
// language planner and is never presented as evidence of model quality.
// It always proposes the same fixed one-action script: look at the current
// observation and propose a single "observe" action against the first
// criterion of the current goal.
//
// Usage: node fixtures/scripted-planner.js
// Protocol: one JSON line in on stdin ({requestId, context}), one JSON
// line out on stdout ({requestId, proposal}) per request.
//
// Lives OUTSIDE test/ on purpose: node --test's default file discovery
// treats anything under a directory named test/tests as a test file, and
// this is a long-running stdio worker (it blocks on stdin forever) -- if
// node --test tried to run it directly, the whole suite would hang.

const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return; // malformed input from the host: drop rather than crash the worker
  }
  if (!request || typeof request.requestId !== "string" || !request.context) return;

  const { requestId, context } = request;
  const criteria = (context.goal && context.goal.criteria) || [];
  const firstCriterionId = criteria.length > 0 ? criteria[0].id : "C1";

  const proposal = {
    taskId: context.taskId,
    goalVersion: context.goalVersion,
    basedOnObservationId: (context.observation && context.observation.id) || "fixture-observation",
    criterionIds: [firstCriterionId],
    kind: "actions",
    actions: [{ type: "observe" }],
  };

  process.stdout.write(`${JSON.stringify({ requestId, proposal })}\n`);
});
