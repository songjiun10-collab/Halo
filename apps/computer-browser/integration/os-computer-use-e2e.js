"use strict";

// Manual end-to-end check of OS computer use against the bundled test window (native/macos-os-helper/testapp).
// It drives only that window, through the real policy and the real macOS helper. Needs the Accessibility
// permission for the process running this script. Usage:
//   node integration/os-computer-use-e2e.js <HaloTestApp.app> <halo-os-helper>
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OsComputerUse } = require("../main/harness/os-computer-use");
const { MacOsBackend } = require("../main/harness/macos-os-backend");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [appPath, helperPath] = process.argv.slice(2);
if (!appPath || !helperPath) { console.error("usage: os-computer-use-e2e.js <HaloTestApp.app> <halo-os-helper>"); process.exit(2); }

(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "halo-os-e2e-")), "events.log");
  const app = spawn(path.join(appPath, "Contents/MacOS/HaloTestApp"), [], { env: { HALO_TESTAPP_LOG: log }, stdio: "ignore" });
  const backend = new MacOsBackend({ helperPath });
  const asked = [];
  const cu = new OsComputerUse({ backend, allowedApps: ["dev.halo.testapp"], approve: async (q) => { asked.push(q.reason); return false; } });
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const out = {};
  try {
    await sleep(2500);
    let seen = await cu.observe();
    out.observe = seen.status === "ok" ? { app: seen.observation.window.bundleId, controls: seen.observation.controls.map((c) => `${c.role}:${c.name}${c.secure ? "(secure)" : ""}${c.focused ? "(focused)" : ""}`) } : seen;
    if (seen.status !== "ok") return console.log(JSON.stringify(out, null, 2));
    const center = (name) => { const c = seen.observation.controls.find((x) => x.name === name || (name === "secure" && x.secure)); return c ? { x: c.x + c.w / 2, y: c.y + c.h / 2 } : null; };

    const run = async (label, action) => {
      seen = await cu.observe();
      out[label] = await cu.execute({ observationId: seen.observation.id, ...action });
      await sleep(400);
    };
    await run("type_hello", { type: "os_type_text", text: "hello" });
    await run("click_open", { type: "os_click_at", ...center("Open") });
    await run("click_delete", { type: "os_click_at", ...center("Delete note") });
    await run("click_secure", { type: "os_click_at", ...center("secure") });
    await run("type_rm", { type: "os_type_text", text: "rm -rf x" });
    out.appLog = events();
    out.approvalsAsked = asked;
  } finally {
    backend.close();
    app.kill();
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
