"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyPageTheme } = require("../main/page-theme");

test("pages follow the OS theme, the same one Halo's own UI follows (no pinning)", () => {
  for (const before of ["dark", "light", "system"]) {
    const nativeTheme = { themeSource: before };
    applyPageTheme({ nativeTheme });
    assert.equal(nativeTheme.themeSource, "system");
  }
});

test("pages without a dark theme are not force-darkened", () => {
  const switches = [];
  const app = { commandLine: { appendSwitch: (...args) => switches.push(args) } };
  applyPageTheme({ app, nativeTheme: { themeSource: "system" }, env: {} });
  assert.deepEqual(switches, []);
});

test("a host without nativeTheme is tolerated", () => {
  assert.doesNotThrow(() => applyPageTheme({ nativeTheme: undefined }));
});
