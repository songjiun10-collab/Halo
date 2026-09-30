"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { createElectronTestProfile } = require("./electron-test-profile");

test("Electron integration profiles are private and unique per launch", async () => {
  const first = await createElectronTestProfile();
  const second = await createElectronTestProfile();
  try {
    assert.notEqual(first.userDataDir, second.userDataDir);
    assert.deepEqual(first.argsFor("/tmp/fixture.js"), ["/tmp/fixture.js", `--user-data-dir=${first.userDataDir}`]);
    assert.deepEqual(second.argsFor("/tmp/fixture.js"), ["/tmp/fixture.js", `--user-data-dir=${second.userDataDir}`]);
    assert.equal((await fs.stat(first.userDataDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(second.userDataDir)).mode & 0o777, 0o700);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
