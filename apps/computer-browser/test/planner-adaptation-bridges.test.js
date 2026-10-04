"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { buildContext } = require("../main/harness/context-builder");
const { normalizeGoalSpec } = require("../shared/harness-contracts");
const { ClaudeCodeBridge } = require("../main/harness/providers/claude-code-bridge");
const { CodexPlannerBridge } = require("../main/harness/providers/codex-planner-bridge");
const { NvidiaPlannerBridge } = require("../main/harness/providers/nvidia-planner-bridge");

const taskId = "11111111-1111-1111-1111-111111111111";
const proposal = { taskId, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [],
  kind: "actions", actions: [{ type: "observe" }] };
function context() {
  const goal = normalizeGoalSpec({ originalRequest: "메일과 캘린더의 여행 일정을 확인하고 QR을 한 장으로 묶어줘" },
    { taskId, goalVersion: 1, createdAt: "2026-10-03T00:00:00.000Z" });
  return buildContext({ goal, state: { harnessProfile: "long", plannerEffort: "low", mcp: { enabled: true } },
    observation: { id: "obs-1", url: "https://travel.test/", elements: [] }, recentEvents: [],
    customMemory: [{ text: "HALO_PREF: batching=single", origin: null }] });
}
function transport(provider, result = proposal) {
  let prompt;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = () => {};
    child.stdin = {
      write(text, _encoding, callback) { prompt = text; callback(); },
      end() { queueMicrotask(() => {
        child.stdout.emit("data", provider === "codex"
          ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }) + "\n"
          : JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(result) }));
        child.emit("close", 0);
      }); },
    };
    return child;
  };
  return { spawnFn, prompt: () => prompt };
}

test("Fable and Haiku receive their pinned model tuning plus the current user's workflow at the CLI boundary", async () => {
  for (const model of ["claude-fable-5-1", "claude-haiku-4-5-20251001"]) {
    const fake = transport("claude");
    const bridge = new ClaudeCodeBridge({ model, spawnFn: fake.spawnFn });
    try {
      assert.deepEqual(await bridge.start(context()), proposal);
      assert.match(fake.prompt(), model.includes("fable") ? /Fable 5.1/ : /Haiku 4.5/);
      assert.match(fake.prompt(), /at most one browser action/);
      assert.match(fake.prompt(), /mcp_search/);
      assert.match(fake.prompt(), /original reservation QR/);
    } finally { await bridge.close(); }
  }
});

test("Codex and NVIDIA receive the same bounded adaptation through their own transports", async () => {
  const fake = transport("codex");
  const codex = new CodexPlannerBridge({ model: "gpt-6-luna", spawnFn: fake.spawnFn });
  let sent;
  const nvidia = new NvidiaPlannerBridge({ model: "moonshotai/kimi-k3", apiKey: "fake-test-key", fetchFn: async (_url, options) => {
    sent = JSON.parse(options.body).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }] }));
  } });
  try {
    assert.deepEqual(await codex.start(context()), proposal);
    assert.deepEqual(await nvidia.start(context()), proposal);
    for (const prompt of [fake.prompt(), sent]) {
      assert.match(prompt, /at most one browser action/);
      assert.match(prompt, /original reservation QR/);
      assert.match(prompt, /plannerAdaptation/);
    }
    assert.match(fake.prompt(), /GPT-6 Luna/);
    assert.match(sent, /Kimi K3/);
  } finally { await codex.close(); await nvidia.close(); }
});

test("a Fable room turn keeps its say/pass/propose_task protocol even after browser personalization", async () => {
  const fake = transport("claude", { kind: "pass" });
  const bridge = new ClaudeCodeBridge({ model: "claude-fable-5-1", spawnFn: fake.spawnFn });
  try {
    assert.deepEqual(await bridge.start({ roomTurn: {}, plannerAdaptation: context().plannerAdaptation }), { kind: "pass" });
    assert.doesNotMatch(fake.prompt(), /at most one browser action|original reservation QR|Fable 5.1 is designed/);
    assert.match(fake.prompt(), /propose_task/);
  } finally { await bridge.close(); }
});
