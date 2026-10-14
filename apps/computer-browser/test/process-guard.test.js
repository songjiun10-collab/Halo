"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installProcessGuard } = require("../main/process-guard");

function setup(options = {}) {
  const proc = new EventEmitter();
  const logs = [];
  const exits = [];
  let clock = 0;
  const guard = installProcessGuard(proc, { log: (...args) => logs.push(args.join(" ")), exit: (code) => exits.push(code), now: () => clock, ...options });
  return { proc, logs, exits, guard, tick: (ms) => { clock += ms; } };
}

test("a stray rejection or exception is logged and the host keeps running", () => {
  const { proc, logs, exits } = setup();
  proc.emit("unhandledRejection", new Error("a page died mid-command"), Promise.resolve());
  proc.emit("uncaughtException", new Error("a listener threw"), "uncaughtException");
  assert.deepEqual(exits, []);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /unhandled rejection.*a page died mid-command/i);
  assert.match(logs[1], /uncaught exception.*a listener threw/i);
});

test("odd rejection values are logged without throwing", () => {
  const { proc, exits } = setup();
  for (const reason of [undefined, null, "text", 42, { code: "x" }, Object.create(null)]) proc.emit("unhandledRejection", reason, Promise.resolve());
  assert.deepEqual(exits, []);
});

test("a crash loop still exits, so the service manager can restart a clean process", () => {
  const { proc, exits, tick } = setup({ limit: 5, windowMs: 10_000 });
  for (let i = 0; i < 5; i += 1) { proc.emit("uncaughtException", new Error(`boom ${i}`)); tick(100); }
  assert.deepEqual(exits, [], "five in a row is the limit, not over it");
  proc.emit("uncaughtException", new Error("boom 5"));
  assert.deepEqual(exits, [1]);
});

test("errors spread over time never add up to a crash loop", () => {
  const { proc, exits, tick } = setup({ limit: 3, windowMs: 1000 });
  for (let i = 0; i < 20; i += 1) { proc.emit("uncaughtException", new Error("rare")); tick(600); }
  assert.deepEqual(exits, []);
});

test("rejections count toward the loop limit too, and uninstall removes the handlers", () => {
  const { proc, exits, guard } = setup({ limit: 2, windowMs: 1000 });
  proc.emit("unhandledRejection", new Error("1")); proc.emit("unhandledRejection", new Error("2")); proc.emit("unhandledRejection", new Error("3"));
  assert.deepEqual(exits, [1]);
  guard.uninstall();
  assert.equal(proc.listenerCount("unhandledRejection"), 0);
  assert.equal(proc.listenerCount("uncaughtException"), 0);
});
