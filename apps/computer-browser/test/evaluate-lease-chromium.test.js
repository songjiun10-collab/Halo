"use strict";

// Item 8 end to end on a real Chromium page: evaluate is refused without a lease,
// runs with one, is audited, and the lease is bounded by its use count.
// Skipped unless a Chromium binary is found (HALO_CHROMIUM or the local trial build).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { EvaluateLeases } = require("../main/harness/evaluate-lease");

const CHROMIUM = [
  process.env.HALO_CHROMIUM,
  path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"),
  path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"),
].find((candidate) => candidate && fs.existsSync(candidate));

test("real Chromium: evaluate needs a lease, is audited, and expires with its uses", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>Leased</title><p>hi</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-lease-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await new Promise((resolve) => { chrome.once("exit", resolve); chrome.kill("SIGTERM"); setTimeout(resolve, 5000); });
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 900, height: 600 });
  const leases = new EvaluateLeases({ maxUses: 2 });
  const adapter = new BrowserAdapter({ view, permissionMode: "full", evaluateLeases: leases, taskId: "task-1" });
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/` })).status, "ok");

  const denied = await adapter.execute({ type: "evaluate", expression: "document.title" });
  assert.equal(denied.status, "failed");
  assert.equal(denied.errorCode, "evaluate_not_leased");

  leases.grant("task-1", base, "read the title");
  const ok = await adapter.execute({ type: "evaluate", expression: "document.title" });
  assert.equal(ok.status, "ok");
  assert.equal(ok.evaluateResult.value, "Leased");
  assert.equal((await adapter.execute({ type: "evaluate", expression: "1+1" })).status, "ok");
  const spent = await adapter.execute({ type: "evaluate", expression: "2+2" });
  assert.equal(spent.errorCode, "evaluate_not_leased", "the lease ends after its use count");
  assert.ok(leases.audit().length >= 1, "grants and uses are recorded");

  leases.grant("task-1", "http://example.invalid", "other origin");
  const wrongOrigin = await adapter.execute({ type: "evaluate", expression: "3+3" });
  assert.equal(wrongOrigin.errorCode, "evaluate_not_leased", "a lease for another origin does not authorize this page");
});
