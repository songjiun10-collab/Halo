"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { attachSessionVault } = require("../main/session-vault-setup");

function setup(overrides = {}) {
  const calls = { created: [], set: [] };
  const storage = { tag: "storage" };
  const vault = { tag: "vault" };
  return {
    calls, storage, vault,
    args: {
      app: { getPath: (name) => (name === "userData" ? "/data/halo" : "/x") },
      safeStorage: storage,
      cdpEngine: { setSessionVault: (v) => calls.set.push(v) },
      isChromium: true,
      createSessionVault: (options) => { calls.created.push(options); return vault; },
      path,
      ...overrides,
    },
  };
}

test("Chromium runtime attaches a vault under userData/agent-sessions with the given storage", () => {
  const { args, calls, storage, vault } = setup();
  assert.equal(attachSessionVault(args), vault);
  assert.deepEqual(calls.created, [{ dir: path.join("/data/halo", "agent-sessions"), storage }]);
  assert.deepEqual(calls.set, [vault]);
});

test("Electron runtime does nothing", () => {
  const { args, calls } = setup({ isChromium: false });
  assert.equal(attachSessionVault(args), null);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.set.length, 0);
});

test("a throwing createSessionVault falls back to no vault", () => {
  const { args, calls } = setup({ createSessionVault: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => attachSessionVault(args));
  assert.equal(attachSessionVault(args), null);
  assert.equal(calls.set.length, 0);
});
