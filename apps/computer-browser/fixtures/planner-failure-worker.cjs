"use strict";
// Disposable transport fixture: no model CLI, credentials or network.
const { createWorkerLoop } = require("../main/harness/providers/claude-code-worker");
createWorkerLoop({
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  bridge: { start: async () => { throw Object.assign(new Error("synthetic-private-detail"), { code: "cli_error" }); } },
});
