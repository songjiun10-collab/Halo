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

test("a bridge rejection writes nothing to stdout and only logs to stderr -- planner-stdio.js has no error frame, so this deliberately lets its own 60s timeout surface the failure as planner_error, exactly like any other broken planner", async () => {
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

  assert.equal(stdoutChunks.join(""), "");
  assert.ok(stderrChunks.join("").includes("fail-1"));
  assert.ok(stderrChunks.join("").includes("boom"));

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
