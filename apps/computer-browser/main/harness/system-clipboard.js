"use strict";

// Host-side write to the OS clipboard: the human Mod+C path and the agent
// `copy` action. Reading the clipboard is deliberately NOT implemented --
// nothing in HALO should read what the user has copied.

const childProcess = require("node:child_process");

function writeText(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (process.platform !== "darwin") return false;
  const result = childProcess.spawnSync("/usr/bin/pbcopy", [], { input: text, timeout: 5000 });
  return result.status === 0;
}

module.exports = { writeText };
