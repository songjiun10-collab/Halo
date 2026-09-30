"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { findRealNodeBinary, resolvePlannerCommand } = require("../main/harness/planner-command");

async function makeFakeExecutable(dir, name, scriptBody) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, `#!/bin/sh\n${scriptBody}\n`, "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

test("resolvePlannerCommand: HALO_PLANNER_COMMAND always wins, even over a real node on PATH", () => {
  const result = resolvePlannerCommand({
    env: { HALO_PLANNER_COMMAND: "/custom/planner", HALO_NODE_COMMAND: "/custom/node", PATH: "/usr/bin" },
    execPath: "/electron/bin",
    findNode: () => "/found/node",
  });
  assert.deepEqual(result, { command: "/custom/planner", env: {} });
});

test("resolvePlannerCommand: HALO_NODE_COMMAND wins when HALO_PLANNER_COMMAND is unset", () => {
  const result = resolvePlannerCommand({
    env: { HALO_NODE_COMMAND: "/custom/node", PATH: "/usr/bin" },
    execPath: "/electron/bin",
    findNode: () => "/found/node",
  });
  assert.deepEqual(result, { command: "/custom/node", env: {} });
});

test("resolvePlannerCommand: with no explicit override, uses a detected real node with no extra env", () => {
  const result = resolvePlannerCommand({
    env: { PATH: "/usr/bin" },
    execPath: "/electron/bin",
    findNode: () => "/usr/bin/node",
  });
  assert.deepEqual(result, { command: "/usr/bin/node", env: {} });
});

test("resolvePlannerCommand: falls back to execPath + ELECTRON_RUN_AS_NODE when no real node is found", () => {
  const result = resolvePlannerCommand({
    env: { PATH: "/usr/bin" },
    execPath: "/electron/bin",
    findNode: () => null,
  });
  assert.deepEqual(result, { command: "/electron/bin", env: { ELECTRON_RUN_AS_NODE: "1" } });
});

test("findRealNodeBinary: finds and verifies a real node-like binary on PATH (no shell involved)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-fakenode-"));
  const nodePath = await makeFakeExecutable(dir, "node", "echo v20.11.0");

  const found = findRealNodeBinary({ pathEnv: dir });
  assert.equal(found, nodePath);
});

test("findRealNodeBinary: skips a same-named executable that does not actually behave like node", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-fakenode-decoy-"));
  await makeFakeExecutable(dir, "node", "echo not-node-at-all");

  const found = findRealNodeBinary({ pathEnv: dir });
  assert.equal(found, null);
});

test("findRealNodeBinary: keeps searching later PATH entries after a decoy that fails verification", async () => {
  const decoyDir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-fakenode-decoy2-"));
  await makeFakeExecutable(decoyDir, "node", "echo nope");
  const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-fakenode-real-"));
  const realNodePath = await makeFakeExecutable(realDir, "node", "echo v18.19.0");

  const found = findRealNodeBinary({ pathEnv: [decoyDir, realDir].join(path.delimiter) });
  assert.equal(found, realNodePath);
});

test("findRealNodeBinary: returns null when PATH has no node anywhere", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-fakenode-empty-"));
  const found = findRealNodeBinary({ pathEnv: dir });
  assert.equal(found, null);
});

test("findRealNodeBinary: a PATH entry containing shell metacharacters is treated as a literal path, never interpreted by a shell", async () => {
  // If detection ever shelled out with string interpolation, a directory
  // name like this could inject a second command. fs.accessSync/execFileSync
  // never invoke a shell, so this must resolve exactly like any other
  // directory name -- proving the metacharacters are inert here.
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "halo-fakenode-shellchars-"));
  const trickyDir = path.join(parent, "weird;`touch$(echo x)`&&rm-name");
  await fs.mkdir(trickyDir);
  const realNodePath = await makeFakeExecutable(trickyDir, "node", "echo v22.0.0");

  const found = findRealNodeBinary({ pathEnv: trickyDir });
  assert.equal(found, realNodePath);
  // No stray file from shell interpretation of the directory name.
  const siblingEntries = await fs.readdir(parent);
  assert.deepEqual(siblingEntries, [path.basename(trickyDir)]);
});
