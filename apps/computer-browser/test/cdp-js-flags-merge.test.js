"use strict";

// Regression tests for the single --js-flags switch invariant.
//
// Why this exists: base's CommandLine stores switches in a map keyed by name
// (base/command_line.cc:454), so a SECOND --js-flags switch OVERWRITES the
// first instead of merging with it, and the only duplicate-switch handlers in
// the Chromium tree are base/command_line_unittest.cc:910 and
// base/test/launcher/unit_test_launcher.cc:330 -- neither is installed by a
// launched browser. HALO already passes --max-old-space-size=512 to bound
// renderer memory; emitting a second --js-flags would silently discard it and
// hand every renderer V8's default, multi-GB heap.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launchFlags, jsFlags, V8_FLAGS } = require("../main/harness/cdp-browser-host");

const jsFlagArgs = (flags) => flags.filter((flag) => flag.startsWith("--js-flags="));

test("the renderer heap cap survives when a caller supplies its own V8 flags", () => {
  const flags = launchFlags(["--js-flags=--sparkplug=0"], true, "/tmp/p");
  assert.equal(
    jsFlagArgs(flags).length,
    1,
    "exactly one --js-flags switch may reach the command line; a second one overwrites the first",
  );
  const merged = jsFlagArgs(flags)[0];
  assert.ok(merged.includes("--max-old-space-size=512"), `512MB renderer heap cap must not be discarded, got: ${merged}`);
  assert.ok(merged.includes("--sparkplug=0"), `caller flag must be preserved, got: ${merged}`);
});

test("the cap is present even with no caller flags", () => {
  const flags = launchFlags(undefined, true, "/tmp/p");
  assert.equal(jsFlagArgs(flags).length, 1);
  assert.equal(jsFlagArgs(flags)[0], "--js-flags=--max-old-space-size=512");
});

test("a multi-flag caller --js-flags string is folded into the single switch", () => {
  const flags = launchFlags(["--js-flags=--sparkplug=0 --max-semi-space-size=2"], true, "/tmp/p");
  assert.equal(jsFlagArgs(flags).length, 1);
  const merged = jsFlagArgs(flags)[0];
  for (const expected of ["--max-old-space-size=512", "--sparkplug=0", "--max-semi-space-size=2"]) {
    assert.ok(merged.includes(expected), `expected ${expected} in ${merged}`);
  }
});

test("a caller repeating our own V8 flag does not duplicate it", () => {
  const flags = launchFlags(["--js-flags=--max-old-space-size=512"], true, "/tmp/p");
  assert.equal(jsFlagArgs(flags).length, 1);
  assert.equal(jsFlagArgs(flags)[0], "--js-flags=--max-old-space-size=512");
});

test("non-V8 caller flags still pass through alongside the merged switch", () => {
  const flags = launchFlags(["--mute-audio"], true, "/tmp/p");
  assert.ok(flags.includes("--mute-audio"));
  assert.equal(jsFlagArgs(flags).length, 1);
  assert.equal(jsFlagArgs(flags)[0], "--js-flags=--max-old-space-size=512");
});

test("cdp-engine's shared-policy --process-per-site path still emits one switch", () => {
  const flags = launchFlags(["--process-per-site"], true, "/tmp/p");
  assert.ok(flags.includes("--process-per-site"));
  assert.equal(jsFlagArgs(flags).length, 1);
});

test("jsFlags() merges V8_FLAGS with extras, de-duplicated", () => {
  assert.deepEqual([...V8_FLAGS], ["--max-old-space-size=512"]);
  assert.equal(jsFlags(), "--js-flags=--max-old-space-size=512");
  assert.equal(jsFlags(["--sparkplug=0"]), "--js-flags=--max-old-space-size=512 --sparkplug=0");
  assert.equal(
    jsFlags(["--max-old-space-size=512"]),
    "--js-flags=--max-old-space-size=512",
    "an extra repeating our own flag must not duplicate it",
  );
});

test("the desktop path keeps its own flag set and still emits one switch", () => {
  const flags = launchFlags(undefined, false, "/private/profile", "/Applications/Chromium", {
    desktop: true,
    appUrl: "http://127.0.0.1:8123/",
  });
  assert.equal(jsFlagArgs(flags).length, 1);
  assert.ok(jsFlagArgs(flags)[0].includes("--max-old-space-size=512"));
  assert.ok(flags.includes("--app=http://127.0.0.1:8123/"));
});

test("the agent headless_shell uses the Mac's real GPU and sets no forced language", () => {
  const shell = "/x/headless_shell";
  const agent = launchFlags(undefined, true, "/tmp/p", shell);
  if (process.platform === "darwin") {
    for (const flag of ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]) assert.ok(agent.includes(flag), flag);
  }
  // A forced --lang made Reddit show its human check on every load (5/5 vs 0/5 without it), so none is set.
  assert.ok(!agent.some((flag) => flag.startsWith("--lang=") || flag.startsWith("--accept-lang=")), "no forced language");
  assert.ok(!launchFlags(undefined, true, "/tmp/p", "/x/Chromium").includes("--use-angle=metal"), "only headless_shell needs the GPU flags");
});
