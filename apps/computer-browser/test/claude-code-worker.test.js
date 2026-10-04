"use strict";

// Tests for main/harness/providers/claude-code-worker.js's createWorkerLoop:
// the JSONL stdio protocol layer that must stay wire-compatible with
// planner-stdio.js's PlannerStdioAdapter (one `{requestId, context}` line in,
// one `{requestId, proposal}` line out). Uses fake stdin/stdout/stderr
// streams and a fake bridge -- no real claude CLI, no real ClaudeCodeBridge,
// no real process spawned, and no real user/browser data anywhere in these
// fixtures.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { createWorkerLoop } = require("../main/harness/providers/claude-code-worker");

function makeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks = [];
  const stderrChunks = [];
  stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
  stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
  return { stdin, stdout, stderr, stdoutChunks, stderrChunks };
}

function writeLine(stream, obj) {
  stream.write(`${JSON.stringify(obj)}\n`);
}

async function flush(times = 2) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("relays one request to the bridge and writes exactly one matching JSONL response line", async () => {
  const { stdin, stdout, stderr, stdoutChunks } = makeStreams();
  const seenContexts = [];
  const bridge = {
    start: async (context) => {
      seenContexts.push(context);
      return { kind: "finish", ok: true };
    },
  };
  createWorkerLoop({ stdin, stdout, stderr, bridge });

  writeLine(stdin, { requestId: "r1", context: { taskId: "t1" } });
  await flush();

  assert.deepEqual(seenContexts, [{ taskId: "t1" }]);
  assert.equal(stdoutChunks.join(""), `${JSON.stringify({ requestId: "r1", proposal: { kind: "finish", ok: true } })}\n`);
});

test("forwards MCP capability and bounded-result instructions in planner context unchanged", async () => {
  const { stdin, stdout, stderr, stdoutChunks } = makeStreams();
  let seen;
  const context = {
    taskId: "t1",
    progress: { mcp: { enabled: true, actions: ["mcp_search", "mcp_describe", "mcp_propose"] } },
    observation: { mcpResult: { action: "mcp_search", outcome: "ok", result: "untrusted output", truncated: false } },
  };
  const bridge = { start: async (input) => { seen = input; return { kind: "need_user", reason: "done" }; } };
  createWorkerLoop({ stdin, stdout, stderr, bridge });
  writeLine(stdin, { requestId: "mcp", context });
  await flush();
  assert.deepEqual(seen, context);
  assert.equal(JSON.parse(stdoutChunks.join("")).proposal.kind, "need_user");
});

test("processes multiple sequential request lines in order", async () => {
  const { stdin, stdout, stderr, stdoutChunks } = makeStreams();
  let call = 0;
  const bridge = {
    start: async () => {
      call += 1;
      return { n: call };
    },
  };
  createWorkerLoop({ stdin, stdout, stderr, bridge });

  writeLine(stdin, { requestId: "a", context: {} });
  await flush();
  writeLine(stdin, { requestId: "b", context: {} });
  await flush();

  assert.equal(
    stdoutChunks.join(""),
    `${JSON.stringify({ requestId: "a", proposal: { n: 1 } })}\n${JSON.stringify({ requestId: "b", proposal: { n: 2 } })}\n`,
  );
});

test("providers without an explicit image route fail closed instead of receiving screenshot paths", async () => {
  const { stdin, stdout, stderr, stdoutChunks } = makeStreams();
  let starts = 0;
  const bridge = { start: async () => { starts += 1; return { kind: "finish" }; } };
  createWorkerLoop({ stdin, stdout, stderr, bridge });
  writeLine(stdin, { requestId: "image", context: {}, attachments: [{ kind: "image", id: "22222222-2222-4222-8222-222222222222", path: "/tmp/halo-computer-use-x/observation.png" }] });
  await flush();
  assert.equal(starts, 0);
  assert.deepEqual(JSON.parse(stdoutChunks.join("")), { requestId: "image", error: { code: "computer_use_provider_unavailable" } });
});

test("a bridge rejection returns a correlated bounded error without leaking CLI diagnostics", async () => {
  const { stdin, stdout, stderr, stdoutChunks, stderrChunks } = makeStreams();
  let call = 0;
  const bridge = {
    start: async () => {
      call += 1;
      if (call === 1) throw new Error("cli_error: boom");
      return { ok: true };
    },
  };
  createWorkerLoop({ stdin, stdout, stderr, bridge });

  writeLine(stdin, { requestId: "fail-1", context: {} });
  await flush();

  assert.deepEqual(JSON.parse(stdoutChunks.join("")), { requestId: "fail-1", error: { code: "planner_failed" } });
  assert.ok(stderrChunks.join("").includes("fail-1"));
  assert.ok(!stderrChunks.join("").includes("boom"));
  stdoutChunks.length = 0;

  // The loop itself must not crash/hang: a later, successful request on the
  // same (persistent) worker process still gets a real response.
  writeLine(stdin, { requestId: "ok-1", context: {} });
  await flush();

  assert.equal(stdoutChunks.join(""), `${JSON.stringify({ requestId: "ok-1", proposal: { ok: true } })}\n`);
});

test("drops a line that is not valid JSON without crashing the loop", async () => {
  const { stdin, stdout, stderr, stdoutChunks, stderrChunks } = makeStreams();
  const bridge = { start: async () => ({ ok: true }) };
  createWorkerLoop({ stdin, stdout, stderr, bridge });

  stdin.write("not json\n");
  await flush();

  assert.equal(stdoutChunks.join(""), "");
  assert.ok(stderrChunks.join("").length > 0);

  writeLine(stdin, { requestId: "still-works", context: {} });
  await flush();
  assert.equal(stdoutChunks.join(""), `${JSON.stringify({ requestId: "still-works", proposal: { ok: true } })}\n`);
});

test("drops a line missing requestId without crashing the loop", async () => {
  const { stdin, stdout, stderr, stdoutChunks, stderrChunks } = makeStreams();
  const bridge = { start: async () => ({ ok: true }) };
  createWorkerLoop({ stdin, stdout, stderr, bridge });

  writeLine(stdin, { context: {} });
  await flush();

  assert.equal(stdoutChunks.join(""), "");
  assert.ok(stderrChunks.join("").length > 0);
});

test("ignores blank lines", async () => {
  const { stdin, stdout, stderr, stdoutChunks, stderrChunks } = makeStreams();
  const bridge = { start: async () => ({ ok: true }) };
  createWorkerLoop({ stdin, stdout, stderr, bridge });

  stdin.write("\n");
  await flush();

  assert.equal(stdoutChunks.join(""), "");
  assert.equal(stderrChunks.join(""), "");
});

test("attaches the bridge's usage to the response line only when there is some", async () => {
  const { stdin, stdout, stderr, stdoutChunks } = makeStreams();
  const usage = { provider: "claude", inputTokens: 4 };
  let pending = usage;
  const bridge = { start: async () => ({ kind: "finish" }), takeUsage: () => { const u = pending; pending = null; return u; } };
  createWorkerLoop({ stdin, stdout, stderr, bridge });
  writeLine(stdin, { requestId: "r1", context: {} });
  await flush();
  writeLine(stdin, { requestId: "r2", context: {} });
  await flush();
  const lines = stdoutChunks.join("").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { requestId: "r1", proposal: { kind: "finish" }, usage });
  assert.deepEqual(lines[1], { requestId: "r2", proposal: { kind: "finish" } });
});
