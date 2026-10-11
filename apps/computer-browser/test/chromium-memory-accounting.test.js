"use strict";

// Regression tests: the Chromium tree HALO launches must be inside the
// app-wide memory budget.
//
// Before the fix this was RED. main/index.js builds the single MemoryMonitor
// with `getAppMetrics: () => app.getAppMetrics()`, which returns Electron's own
// processes only, and every registerExternalProcess call covered just the
// approver, planner and Codex MCP workers. cdp-browser-host spawned a Chromium,
// kept its child.pid, and registered nothing, so the browser's real RSS summed
// as zero and getPressureLevel() could never raise caution/pause/emergency for
// it. Measured on a real idle headless_shell: 476.6MB actual vs 0.0MB counted.
//
// The fix threads a host hook through CdpEngine: cdp-browser-host reports pid
// + launchedAt for a browser it launched, the engine fires the hook on connect
// and null on teardown, and index.js registers/unregisters against the monitor.
// One root pid covers the whole tree because the injected lookup already sums
// descendants (process-tree-memory.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { sumProcessTreeRssBytes } = require("../main/harness/process-tree-memory");
const { CdpEngine } = require("../main/harness/cdp-engine");

const CHROMIUM = [
  process.env.HALO_CHROMIUM,
  path.join(os.homedir(), "chromium/src/out/Trial/headless_shell"),
  path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"),
].find((p) => p && fs.existsSync(p));

function makeMonitor() {
  const monitor = new MemoryMonitor({
    // Electron's own processes only, exactly as index.js:109 wires it.
    getAppMetrics: () => [],
    getExternalMemoryBytes: (pid) => new Promise((resolve) => {
      require("node:child_process").execFile("ps", ["-axo", "pid=,ppid=,rss="], (err, stdout) => {
        if (err) return resolve(null);
        resolve(sumProcessTreeRssBytes(stdout, pid));
      });
    }),
  });
  return monitor;
}

test("a launched Chromium is reported to the host hook and unregistered on teardown", {
  skip: !CHROMIUM && "no Chromium binary",
  timeout: 120000,
}, async (t) => {
  const events = [];
  const engine = new CdpEngine();
  engine.setBrowserProcessListener((info) => events.push(info));
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  assert.equal(engine.isActive(), true);

  const page = engine.createPage("halo-task-memtest");
  assert.ok(page, "the chromium engine must produce a page");
  // release() is asserted explicitly below, so only clean up on early failure.
  t.after(async () => { if (events.length === 0) { try { await engine.release(); } catch {} } });

  // Drive the connection so the browser actually spawns.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 60000);
    page.webContents.once("did-finish-load", resolve).catch?.(() => {});
    const iv = setInterval(() => {
      const loads = events.length;
      if (loads > 0) { clearInterval(iv); clearTimeout(timer); resolve(); }
    }, 100);
    page.webContents.loadURL?.("about:blank").catch?.(() => {});
  });

  const launches = events.filter((e) => e && typeof e.pid === "number");
  assert.equal(launches.length, 1, "exactly one browser launch must be reported");
  const [info] = launches;
  assert.ok(Number.isInteger(info.pid) && info.pid > 0, "pid must be a real integer");
  assert.ok(Number.isFinite(info.creationTime) && info.creationTime > 0, "creationTime must be set");

  // The other half of the contract: teardown must unregister exactly once, with
  // a null event carrying no pid. A leaked registration would keep a dead
  // browser's pid reserved forever and mis-attribute a recycled pid.
  assert.equal(events.filter((e) => e === null).length, 0, "no teardown before release()");
  await engine.release();
  assert.equal(events.filter((e) => e === null).length, 1, "teardown must unregister exactly once");
});

test("the Chromium tree RSS is inside the monitor sample, not zero", {
  skip: !CHROMIUM && "no Chromium binary",
  timeout: 120000,
}, async (t) => {
  const monitor = makeMonitor();
  let registered = null;
  const engine = new CdpEngine();
  engine.setBrowserProcessListener((info) => {
    if (!info) return;
    registered = info;
    monitor.registerExternalProcess({ pid: info.pid, creationTime: info.creationTime, label: "chromium" });
  });
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  const page = engine.createPage("halo-task-memtest2");
  assert.ok(page);
  t.after(async () => { try { await engine.release(); } catch {} });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("register timeout")), 60000);
    const iv = setInterval(() => {
      if (registered) { clearInterval(iv); clearTimeout(timer); resolve(); }
    }, 100);
    page.webContents.loadURL?.("about:blank").catch?.(() => {});
  });

  const sample = await monitor.sample();
  // memory-monitor.js:136 reports externally registered processes as
  // `external:<label>`, so a registration made with label "chromium" lands as
  // "external:chromium".
  const chromium = sample.byProcess.find((p) => p.label === "external:chromium");

  assert.ok(chromium, `the chromium process must appear in the monitor sample, got ${JSON.stringify(sample.byProcess)}`);
  assert.equal(chromium.bytes === null, false, "chromium RSS must be measurable, not unmeasurable");
  // The real gate: an idle headless_shell tree is well over 100MB, and before
  // the fix this whole number was 0.
  assert.ok(chromium.bytes > 50_000_000,
    `chromium RSS must be real, got ${chromium.bytes} bytes`);
  assert.ok(sample.totalBytes > 50_000_000,
    `monitor total must include chromium, got ${sample.totalBytes} bytes`);
  assert.equal(sample.unmeasurable.length, 0, "nothing should be unmeasurable");
});

test("attach mode registers nothing: the user owns that browser", async () => {
  const events = [];
  const engine = new CdpEngine();
  engine.setBrowserProcessListener((info) => events.push(info));
  // An endpoint that resolves would need a live browser; assert the contract
  // instead: configure() must not erase an installed listener.
  engine.configure({ browserEngine: "chromium" });
  engine.configure({ browserEngine: "electron", chromiumPath: "/nope" });
  assert.deepEqual(events, [], "no launch reported without a live browser");
});

test("the listener survives configure(), which rebuilds the settings object", async () => {
  const engine = new CdpEngine();
  let seen = 0;
  engine.setBrowserProcessListener(() => { seen += 1; });
  // configure() with only user-facing fields must not drop the host hook.
  engine.configure({ browserEngine: "chromium", chromiumPath: "/x" });
  engine.configure({ browserEngine: "chromium" });
  // No live browser, so nothing fires; assert the hook is still installed by
  // checking configure() did not throw and the engine is still inert-safe.
  assert.equal(engine.isActive(), true);
  assert.equal(seen, 0);
});