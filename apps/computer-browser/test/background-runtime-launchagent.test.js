"use strict";

// Tests for main/harness/launch-agent-manager.js (multi-agent background
// runtime plan, Task 1): resolveBackgroundServiceInvocation() is a pure
// function that describes how the background service WOULD be launched by a
// macOS per-user LaunchAgent -- it never touches launchd, never writes a
// plist, and never installs anything. Real LaunchAgent bootstrap/bootout is
// covered separately by the opt-in fixture smoke script
// (integration/background-runtime-launchagent-smoke.js), never by this unit
// suite.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  resolveBackgroundServiceInvocation,
  LaunchAgentError,
} = require("../main/harness/launch-agent-manager");

const EXECUTABLE_PATH = path.join(path.sep, "Applications", "Halo.app", "Contents", "MacOS", "Halo");
const APP_PATH = path.join(path.sep, "Users", "test-user", "Halo", "apps", "computer-browser");

test("LaunchAgent invocation: produces a stable per-user label that does not change across calls", () => {
  const first = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "songjiun" });
  const second = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "songjiun" });
  assert.equal(first.label, second.label);
  assert.match(first.label, /^com\.halo\.computerbrowser\.background\.[A-Za-z0-9._-]+$/);
});

test("LaunchAgent invocation: distinct userId values never collide on the same label", () => {
  const a = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "songjiun" });
  const b = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "other-user" });
  assert.notEqual(a.label, b.label);
});

test("LaunchAgent invocation: exact executable path and argument array, no shell string anywhere in the result", () => {
  const result = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "songjiun" });
  assert.equal(result.executablePath, EXECUTABLE_PATH);
  assert.ok(Array.isArray(result.arguments));
  assert.deepEqual(result.arguments, [APP_PATH, "--halo-background-service"]);
  // Exactly this shape -- no "command"/"commandLine"/joined-string escape
  // hatch that a launchd wrapper could be tempted to exec via a shell.
  assert.deepEqual(Object.keys(result).sort(), ["arguments", "executablePath", "label"]);
  for (const value of Object.values(result)) {
    if (typeof value === "string") assert.ok(!value.includes(" "), "no field concatenates executable+args into a single string");
  }
});

test("LaunchAgent invocation: omits the app-path argument in packaged mode (no appPath given)", () => {
  const result = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, userId: "songjiun" });
  assert.deepEqual(result.arguments, ["--halo-background-service"]);
});

test("LaunchAgent invocation: never inherits UI-only task arguments such as --halo-layout", () => {
  const originalArgv = process.argv;
  try {
    process.argv = [...originalArgv, "--halo-layout={\"approvalQueueHeight\":120}", "--halo-task-id=abc"];
    const result = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "songjiun" });
    for (const arg of result.arguments) {
      assert.ok(!arg.startsWith("--halo-layout"), "must not inherit the UI-only layout flag");
      assert.ok(!arg.startsWith("--halo-task-id"), "must not inherit any UI-only task argument");
    }
    assert.deepEqual(result.arguments, [APP_PATH, "--halo-background-service"]);
  } finally {
    process.argv = originalArgv;
  }
});

test("LaunchAgent invocation: rejects a relative executablePath", () => {
  assert.throws(
    () => resolveBackgroundServiceInvocation({ executablePath: "Halo", appPath: APP_PATH, userId: "songjiun" }),
    LaunchAgentError,
  );
});

test("LaunchAgent invocation: rejects a relative appPath", () => {
  assert.throws(
    () => resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: "apps/computer-browser", userId: "songjiun" }),
    LaunchAgentError,
  );
});

test("LaunchAgent invocation: rejects a missing or empty executablePath", () => {
  assert.throws(() => resolveBackgroundServiceInvocation({ appPath: APP_PATH, userId: "songjiun" }), LaunchAgentError);
  assert.throws(() => resolveBackgroundServiceInvocation({ executablePath: "", appPath: APP_PATH, userId: "songjiun" }), LaunchAgentError);
});

test("LaunchAgent invocation: rejects an invalid or unsafe userId", () => {
  for (const userId of [undefined, "", "user name", "../etc", "user;rm -rf", "a".repeat(200)]) {
    assert.throws(
      () => resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId }),
      LaunchAgentError,
      `expected rejection for userId=${JSON.stringify(userId)}`,
    );
  }
});

test("LaunchAgent invocation: result is frozen (label/arguments cannot be mutated by a careless caller)", () => {
  const result = resolveBackgroundServiceInvocation({ executablePath: EXECUTABLE_PATH, appPath: APP_PATH, userId: "songjiun" });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.arguments));
});
