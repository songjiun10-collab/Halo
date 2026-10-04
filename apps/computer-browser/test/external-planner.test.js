"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { selectPlannerLaunch } = require("../main/harness/planner-providers");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("external planners are host selected without accepting arbitrary models or fast flags", () => {
  for (const [id, model] of [["antigravity", "antigravity-default"], ["cursor", "cursor-auto"]]) {
    const launch = selectPlannerLaunch({ providerId: id, model, fast: true, nodeCommand: "node" });
    assert.equal(launch.source, "settings");
    assert.ok(!launch.args.includes("--fast"));
    assert.equal(selectPlannerLaunch({ providerId: id, model: "--force", nodeCommand: "node" }).source, "invalid_model");
  }
});

test("workers reject flag injection and fail before CLI launch without credentials", () => {
  const { parseExternalWorkerArgs } = require("../main/harness/providers/external-planner-worker");
  for (const provider of ["cursor", "antigravity"]) {
    assert.throws(() => parseExternalWorkerArgs(provider, ["--force"]));
    assert.throws(() => parseExternalWorkerArgs(provider, ["--model", "--force"]));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, `../main/harness/providers/${provider}-planner-worker.js`)], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /required/);
    assert.equal(result.stdout, "");
  }
});

for (const provider of ["antigravity", "cursor"]) {
  test(`${provider} denies native tools in an isolated home and validates final proposals`, async () => {
    const { ExternalPlannerBridge } = require("../main/harness/providers/external-planner-bridge");
    let child, options, args;
    const bridge = new ExternalPlannerBridge({ provider, spawnFn: (_command, argv, opts) => {
      args = argv; options = opts;
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit("close", null));
      return child;
    }});
    try {
      const promise = bridge.start({});
      assert.notEqual(options.env.HOME, process.env.HOME);
      assert.equal(options.shell, false);
      assert.equal(options.env.HALO_APPROVER_KEY, undefined);
      const configPath = provider === "cursor" ? `${options.env.CURSOR_CONFIG_DIR}/cli-config.json` : `${options.env.HOME}/.gemini/antigravity-cli/settings.json`;
      const config = JSON.parse(fs.readFileSync(configPath));
      assert.deepEqual(config.permissions.allow, []);
      assert.ok(config.permissions.deny.includes(provider === "cursor" ? "Mcp(*:*)" : "mcp(*)"));
      assert.ok(config.permissions.deny.includes(provider === "cursor" ? "Shell(*)" : "command(*)"));
      assert.ok(!args.includes("--force") && !args.includes("--dangerously-skip-permissions"));
      const envelope = provider === "cursor" ? { type: "result", subtype: "success", is_error: false, result: "{}" } : { status: "SUCCESS", response: "{}" };
      child.stdout.write(JSON.stringify(envelope)); child.emit("close", 0);
      await assert.rejects(promise); // syntactically valid but not a HALO proposal
    } finally { await bridge.close(); }
    assert.equal(fs.existsSync(options.env.HOME), false);
  });
}

for (const provider of ["antigravity", "cursor"]) {
  test(`${provider} returns a validated proposal and never accepts failed output`, async () => {
    const { ExternalPlannerBridge } = require("../main/harness/providers/external-planner-bridge");
    let child;
    const bridge = new ExternalPlannerBridge({ provider, spawnFn: () => {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit("close", null));
      return child;
    }});
    const proposal = { taskId: "11111111-1111-1111-1111-111111111111", goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: ["C1"], kind: "actions", actions: [{ type: "observe" }] };
    const success = provider === "cursor" ? { type: "result", subtype: "success", is_error: false, result: JSON.stringify(proposal) } : { status: "SUCCESS", response: JSON.stringify(proposal) };
    try {
      const pending = bridge.start({});
      child.stdout.write(JSON.stringify(success)); child.emit("close", 0);
      assert.deepEqual(await pending, proposal);
      assert.equal(bridge.takeUsage(), null);
      for (const output of ["null", "{}", "not-json", JSON.stringify({ ...success, is_error: true, status: "ERROR", subtype: "error" })]) assert.throws(() => bridge._readOutput(output));
      const cancelled = bridge.start({}); bridge.cancel();
      await assert.rejects(cancelled, { code: "cancelled" });
      await bridge.close();
    } finally { await bridge.close(); }
  });
}
