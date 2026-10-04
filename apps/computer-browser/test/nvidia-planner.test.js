"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectPlannerLaunch, plannerProviderEnv } = require("../main/harness/planner-providers");
const proposal = { taskId: "11111111-1111-1111-1111-111111111111", goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] };
const reply = (content = JSON.stringify(proposal), finish_reason = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason, message: { role: "assistant", content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));

test("NVIDIA validates credentials and model before any request; worker argv cannot inject options", () => {
  const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
  const { parseNvidiaWorkerArgs } = require("../main/harness/providers/nvidia-planner-worker");
  for (const apiKey of ["", " ", "key\nheader"]) assert.throws(() => new NvidiaPlannerBridge({ apiKey }), { code: "authentication_failed" });
  assert.throws(() => new NvidiaPlannerBridge({ apiKey: "test-only", model: "arbitrary" }), { code: "invalid_model" });
  assert.throws(() => parseNvidiaWorkerArgs(["--model", "--force"]));
  assert.throws(() => parseNvidiaWorkerArgs(["--fast"]));
  assert.deepEqual(parseNvidiaWorkerArgs(["--model", "moonshotai/kimi-k3"]), { model: "moonshotai/kimi-k3" });
});

test("real HTTP fixture exercises authorization, JSON response parsing and usage accounting", async () => {
  const http = require("node:http");
  const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
  let seen;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen = { authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 15, completion_tokens: 8 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge = new NvidiaPlannerBridge({ apiKey: "fixture-key", model: "moonshotai/kimi-k3", fetchFn: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, options) });
  try {
    assert.deepEqual(await bridge.start({}), proposal);
    assert.equal(seen.authorization, "Bearer fixture-key");
    assert.equal(seen.body.model, "moonshotai/kimi-k3");
    assert.equal(bridge.takeUsage().inputTokens, 15);
  } finally {
    await bridge.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});

test("NVIDIA routing pins a model and passes only its provider credential", () => {
  const launch = selectPlannerLaunch({ providerId: "nvidia", model: "moonshotai/kimi-k3", nodeCommand: "node", fast: true });
  assert.equal(launch.source, "settings");
  assert.ok(!launch.args.includes("--fast"));
  assert.deepEqual(plannerProviderEnv(launch, { NVIDIA_API_KEY: "test-only", CURSOR_API_KEY: "no", HALO_APPROVER_KEY: "no" }), { NVIDIA_API_KEY: "test-only" });
});

test("NVIDIA posts one bounded tool-free request and validates the HALO proposal and usage", async () => {
  const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
  let request;
  const bridge = new NvidiaPlannerBridge({ apiKey: "test-only", fetchFn: async (url, options) => { request = { url, ...options }; return reply(); } });
  assert.deepEqual(await bridge.start({}), proposal);
  assert.equal(request.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(request.redirect, "error");
  const body = JSON.parse(request.body);
  assert.equal(body.tools, undefined);
  assert.equal(body.stream, false);
  assert.ok(!request.body.includes("test-only"));
  const usage = bridge.takeUsage();
  assert.equal(usage.provider, "nvidia");
  assert.equal(usage.inputTokens, 20);
  assert.equal(usage.outputTokens, 10);
  assert.equal(bridge.takeUsage(), null);
  await bridge.close();
});

test("NVIDIA failures are sanitized, never retried, and incomplete outputs never dispatch", async () => {
  const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
  for (const [response, code] of [[new Response("private server detail", { status: 401 }), "authentication_failed"], [new Response("private", { status: 429 }), "rate_limited"], [reply("{}"), "invalid_proposal"], [reply(JSON.stringify(proposal), "length"), "invalid_response"]]) {
    let calls = 0;
    const bridge = new NvidiaPlannerBridge({ apiKey: "test-only", fetchFn: async () => { calls++; return response; } });
    await assert.rejects(bridge.start({}), (error) => error.code === code && !error.message.includes("private"));
    assert.equal(calls, 1); await bridge.close();
  }
});

test("NVIDIA timeout and cancellation abort transport and prevent overlapping calls", async () => {
  const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
  const fetchFn = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const bridge = new NvidiaPlannerBridge({ apiKey: "test-only", fetchFn, timeoutMs: 10 });
  const first = bridge.start({});
  await assert.rejects(bridge.start({}), { code: "busy" });
  await assert.rejects(first, { code: "timeout" });
  const second = bridge.start({});
  const cancelled = assert.rejects(second, { code: "cancelled" });
  await bridge.close(); await cancelled;
  await assert.rejects(bridge.start({}), { code: "closed" });
});

test("NVIDIA supports room turns and rejects oversized response bodies", async () => {
  const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");
  const room = new NvidiaPlannerBridge({ apiKey: "test-only", fetchFn: async () => reply('{"kind":"pass"}') });
  assert.deepEqual(await room.start({ roomTurn: {} }), { kind: "pass" }); await room.close();
  const huge = new NvidiaPlannerBridge({ apiKey: "test-only", fetchFn: async () => new Response("x".repeat(1024 * 1024 + 1)) });
  await assert.rejects(huge.start({}), { code: "output_too_large" }); await huge.close();
});
