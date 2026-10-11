"use strict";

// Halowright hw_step end to end on a real Chromium page: role/label/text locators, auto-wait for a button that
// is disabled and rendered late, real input events, effect verification, and fail-closed behaviour.
// Skipped unless a Chromium binary is found (HALO_CHROMIUM or the local trial build).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { runHwStep } = require("../main/harness/halowright");

const CHROMIUM = [
  process.env.HALO_CHROMIUM,
  path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"),
  path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"),
].find((candidate) => candidate && fs.existsSync(candidate));

const PAGE = `<!doctype html><title>Signup</title>
<h1>Newsletter</h1>
<label for="email">Email address</label><input id="email" type="email">
<label for="plan">Plan</label><select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
<div id="slot"></div><p id="result"></p>
<div role="tablist"><button role="tab" aria-selected="true" onclick="document.getElementById('tabclicks').textContent+='x'">5D</button><button role="tab" aria-selected="false">1M</button></div><p id="tabclicks"></p>
<script>
// The submit button is rendered late and starts disabled: a locator must wait for it to become actionable.
setTimeout(() => {
  const button = document.createElement("button");
  button.textContent = "Subscribe"; button.disabled = true;
  button.onclick = () => { document.getElementById("result").textContent = "Subscribed: " + document.getElementById("email").value + " / " + document.getElementById("plan").value; };
  document.getElementById("slot").appendChild(button);
  setTimeout(() => { button.disabled = false; }, 400);
}, 300);
</script>`;

test("real Chromium: hw_step fills, selects and clicks by locator with auto-wait and verifies the effect", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(PAGE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-hw-"));
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
  const wc = view.webContents;
  await wc.loadURL(`${base}/`);
  const authorized = [];
  const options = { timeoutMs: 6000, authorize: (info) => { authorized.push(info); return true; } };
  const read = (expression) => wc.executeJavaScript(expression);

  const filled = await runHwStep(wc, { locator: { label: "Email address" }, op: "fill", text: "a@b.co" }, options);
  assert.equal(filled.status, "ok", JSON.stringify(filled));
  assert.equal(await read("document.getElementById('email').value"), "a@b.co");

  const selected = await runHwStep(wc, { locator: { label: "Plan" }, op: "select", value: "pro" }, options);
  assert.equal(selected.status, "ok", JSON.stringify(selected));
  assert.equal(await read("document.getElementById('plan').value"), "pro");

  // The button does not exist yet / is disabled: the step must wait, then click once it is actionable.
  const clicked = await runHwStep(wc, { locator: { role: "button", name: "Subscribe" }, op: "click" }, options);
  assert.equal(clicked.status, "ok", JSON.stringify(clicked));
  assert.equal(clicked.effect.observed, true);
  assert.equal(await read("document.getElementById('result').textContent"), "Subscribed: a@b.co / pro");
  assert.ok(authorized.length >= 3, "every step went through the authorization callback");

  // A tab that is already selected is a no-op: reported ok without sending input; an unselected one is still clicked.
  const selectedTab = await runHwStep(wc, { locator: { role: "tab", name: "5D" }, op: "click" }, options);
  assert.equal(selectedTab.status, "ok", JSON.stringify(selectedTab));
  assert.equal(await read("document.getElementById('tabclicks').textContent"), "", "no click was sent to the already-selected tab");

  const missing = await runHwStep(wc, { locator: { role: "button", name: "Cancel subscription" }, op: "click" }, { ...options, timeoutMs: 800 });
  assert.equal(missing.status, "failed");

  const denied = await runHwStep(wc, { locator: { role: "button", name: "Subscribe" }, op: "click" }, { timeoutMs: 800 });
  assert.equal(denied.status, "failed");
  assert.equal(denied.errorCode, "authorization_required", "no authorize callback means no page contact");
});
