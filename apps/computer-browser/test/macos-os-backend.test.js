"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { MacOsBackend } = require("../main/harness/macos-os-backend");

function fakeHelper(handler) {
  const spawned = [];
  const spawnFn = (...args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => child.emit("exit");
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const request = JSON.parse(line);
        spawned.push(request);
        const reply = handler(request);
        if (reply) child.stdout.write(JSON.stringify({ id: request.id, ...reply }) + "\n");
      }
    });
    spawned.args = args;
    return child;
  };
  return { spawnFn, spawned };
}

test("observe returns the window and controls, and input commands name the observed app", async () => {
  const { spawnFn, spawned } = fakeHelper((r) => r.cmd === "observe"
    ? { ok: true, window: { app: "Notes", bundleId: "com.apple.Notes", title: "t", pid: 5 }, controls: [{ role: "button", name: "OK", x: 0, y: 0, w: 0.1, h: 0.1 }] }
    : { ok: true });
  const backend = new MacOsBackend({ helperPath: "/x/helper", spawnFn });
  const seen = await backend.observe();
  assert.equal(seen.window.bundleId, "com.apple.Notes");
  await backend.click(0.5, 0.5);
  await backend.typeText("hi");
  await backend.pressKey("Tab");
  assert.deepEqual(spawned.slice(1).map((r) => [r.cmd, r.bundleId]), [["click", "com.apple.Notes"], ["type", "com.apple.Notes"], ["key", "com.apple.Notes"]]);
  backend.close();
});

test("a helper refusal surfaces its code; a silent helper times out", async () => {
  const refuse = fakeHelper(() => ({ ok: false, error: "front_app_changed" }));
  const a = new MacOsBackend({ helperPath: "/x/helper", spawnFn: refuse.spawnFn });
  await assert.rejects(() => a.observe(), { code: "front_app_changed" });
  const silent = fakeHelper(() => null);
  const b = new MacOsBackend({ helperPath: "/x/helper", spawnFn: silent.spawnFn, timeoutMs: 30 });
  await assert.rejects(() => b.observe(), { code: "os_helper_timeout" });
  a.close(); b.close();
});

test("the helper is started with an empty environment and no helper path is a type error", () => {
  assert.throws(() => new MacOsBackend({}), TypeError);
  const { spawnFn } = fakeHelper(() => ({ ok: true, window: {}, controls: [] }));
  let seen;
  const backend = new MacOsBackend({ helperPath: "/x/helper", spawnFn: (...args) => { seen = args; return spawnFn(...args); } });
  backend.observe().catch(() => {});
  assert.deepEqual(seen[2].env, {});
  backend.close();
});
