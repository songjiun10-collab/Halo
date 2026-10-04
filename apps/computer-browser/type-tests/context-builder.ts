import context = require('../runtime-src/main/harness/context-builder');
import latency = require('../runtime-src/integration/approval-latency');

const packet = context.buildContext({
  goal: { taskId: 'id', goalVersion: 1, originalRequest: 'read', amendments: [], constraints: [], criteria: [] },
  state: {}, recentEvents: [], pendingMessages: [],
});
const version: number = packet.goalVersion;
void version;
const tracker = latency.createApprovalLatencyTracker({ onSample: (sample) => { const ms: number = sample.elapsedMs; void ms; } });
tracker.complete('execution_uncertain');
// @ts-expect-error caller must supply a numeric goal version
context.buildContext({ goal: { taskId: 'id', goalVersion: 'one', originalRequest: 'read', amendments: [], constraints: [], criteria: [] }, state: {}, recentEvents: [] });
// @ts-expect-error outcome vocabulary is closed
tracker.complete('maybe');
