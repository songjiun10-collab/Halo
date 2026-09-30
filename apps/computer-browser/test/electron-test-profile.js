"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function createElectronTestProfile() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-electron-test-profile-"));
  await fs.chmod(userDataDir, 0o700);
  return {
    userDataDir,
    // Keep Electron's script at argv[1]; put flags after it so the harness's
    // direct-invocation detection remains intact.
    argsFor(script) { return [script, `--user-data-dir=${userDataDir}`]; },
    async cleanup() { await fs.rm(userDataDir, { recursive: true, force: true }); },
  };
}

module.exports = { createElectronTestProfile };
