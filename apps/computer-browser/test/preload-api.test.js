"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("preload exposes the Work Goal API as narrow IPC invoke wrappers", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../preload/index.js"), "utf8");
  const calls = [];
  let exposed;
  const ipcRenderer = {
    invoke: async (channel, ...args) => { calls.push([channel, ...args]); return { channel, args }; },
    on() {},
    removeListener() {},
  };
  const context = {
    require: (id) => {
      assert.equal(id, "electron");
      return { contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }, ipcRenderer };
    },
    process: { argv: ["--halo-layout={}"] },
    Buffer,
    console,
  };
  vm.runInNewContext(source, context, { filename: "preload/index.js" });

  const methods = [
    ["startWorkGoal", "halo:startWorkGoal", [{ objective: "goal" }]],
    ["getActiveWorkGoal", "halo:getActiveWorkGoal", []],
    ["listWorkGoalHistory", "halo:listWorkGoalHistory", [{ limit: 2, cursor: null }]],
    ["amendWorkGoal", "halo:amendWorkGoal", [1, { objective: "next" }]],
    ["pauseWorkGoal", "halo:pauseWorkGoal", ["goal-id", 1]],
    ["resumeWorkGoal", "halo:resumeWorkGoal", ["goal-id", 1]],
    ["completeWorkGoal", "halo:completeWorkGoal", ["goal-id", 1]],
    ["archiveWorkGoal", "halo:archiveWorkGoal", ["goal-id", 1]],
    ["recordWorkGoalProgress", "halo:recordWorkGoalProgress", ["goal-id", 1, []]],
    ["verifyWorkGoalCriterion", "halo:verifyWorkGoalCriterion", ["goal-id", 1, "criterion"]],
    ["getWorkGoalRecoveryStatus", "halo:getWorkGoalRecoveryStatus", ["goal-id", 1]],
    ["repairWorkGoalReservation", "halo:repairWorkGoalReservation", ["goal-id", 1, "reservation-id"]],
    ["importSessions", "halo:importSessions", [{ browser: "chrome" }]],
    ["listImportedSessions", "halo:listImportedSessions", []],
    ["removeImportedSession", "halo:removeImportedSession", ["claude.ai"]],
    ["getSessionAllowlist", "halo:getSessionAllowlist", []],
    ["setSessionAllowlist", "halo:setSessionAllowlist", [["claude.ai"]]],
  ];
  for (const [method, channel, args] of methods) {
    assert.equal(typeof exposed[method], "function");
    await exposed[method](...args);
    assert.deepEqual(calls.at(-1), [channel, ...args]);
  }
  assert.equal("ipcRenderer" in exposed, false);
  assert.equal("send" in exposed, false);
});
