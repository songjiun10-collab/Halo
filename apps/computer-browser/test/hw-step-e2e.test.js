"use strict";

// Real-Chromium end to end for hw_step: the actual adapter, the actual
// CdpWebContents input path (sendInputEvent / insertText / isolated world), a
// real page -- not scripted fakes. Skips when no Chromium binary is present.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const CHROMIUM = [
  process.env.HALO_CHROMIUM,
  path.join(os.homedir(), "chromium/src/out/TrialLean/Chromium.app/Contents/MacOS/Chromium"),
  path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"),
].find((candidate) => candidate && fs.existsSync(candidate));

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>hw e2e</title>
<style>#far{margin-top:2500px}#late{display:none}</style>
<h1 id="status">idle</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('status').textContent='submitted'">
  <label>Email <input id="email" type="text"></label>
  <button id="send" type="submit">Send</button>
</form>
<label>Password <input id="pw" type="password"></label>
<label>Fruit <select id="fruit"><option>Apple</option><option>Banana</option></select></label>
<label><input id="agree" type="checkbox"> Agree</label>
<button id="go" onclick="document.getElementById('status').textContent='clicked'">Go</button>
<button id="delete" onclick="document.getElementById('status').textContent='deleted'">Delete my account</button>
<button id="late" onclick="document.getElementById('status').textContent='late'">Later</button>
<div style="height:2600px"></div>
<button id="far">Far away</button>
<script>setTimeout(() => { document.getElementById('late').style.display = 'block'; }, 400);</script>`;

test("hw_step end to end on a real page", { skip: !CHROMIUM && "no Chromium binary", timeout: 180000 }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => {
    await engine.release();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = engine.createPage("halo-task-hw-e2e");
  const base = `http://127.0.0.1:${server.address().port}/`;
  const adapter = new BrowserAdapter({ view: { webContents: page.webContents }, permissionMode: "full" });
  const load = () => page.webContents.loadURL(`${base}?t=${Date.now()}`);
  const status = () => page.webContents.executeJavaScript("document.getElementById('status').textContent");
  const value = (id) => page.webContents.executeJavaScript(`document.getElementById('${id}').value`);
  const step = (stepShape) => adapter.execute({ type: "hw_step", step: stepShape });

  // click by role+name
  await load();
  assert.equal((await step({ op: "click", locator: { role: "button", name: "Go" } })).status, "ok");
  assert.equal(await status(), "clicked");

  // hover moves the pointer only
  await load();
  assert.equal((await step({ op: "hover", locator: { role: "button", name: "Go" } })).status, "ok");
  assert.equal(await status(), "idle");

  // fill by label, then Enter submits through the form's own handler
  await load();
  assert.equal((await step({ op: "fill", locator: { label: "Email" }, text: "a@b.co" })).status, "ok");
  assert.equal(await value("email"), "a@b.co");
  assert.equal((await step({ op: "press", key: "Enter" })).status, "ok");
  assert.equal(await status(), "submitted");

  // select by role+name changes the option
  await load();
  assert.equal((await step({ op: "select", locator: { role: "combobox", name: "Fruit" }, value: "Banana" })).status, "ok");
  assert.equal(await value("fruit"), "Banana");

  // check flips the checkbox
  await load();
  assert.equal((await step({ op: "check", locator: { role: "checkbox", name: "Agree" } })).status, "ok");
  assert.equal(await page.webContents.executeJavaScript("document.getElementById('agree').checked"), true);

  // scroll moves the page
  await load();
  assert.equal((await step({ op: "scroll", dy: 700 })).status, "ok");
  assert.ok((await page.webContents.executeJavaScript("window.scrollY")) > 0);

  // a button that appears ~400 ms late still resolves and clicks
  await load();
  assert.equal((await step({ op: "click", locator: { role: "button", name: "Later" } })).status, "ok");
  assert.equal(await status(), "late");

  // a fill that resolves to a password field sends nothing
  await load();
  const refused = await step({ op: "fill", locator: { label: "Password" }, text: "secret" });
  assert.equal(refused.status, "failed");
  assert.equal(refused.errorCode, "not_authorized");
  assert.equal(await value("pw"), "");

  // an irreversible resolved control is refused even though the locator is not an elementId
  await load();
  const denied = await step({ op: "click", locator: { role: "button", name: "Delete my account" } });
  assert.equal(denied.status, "failed");
  assert.equal(denied.errorCode, "not_authorized");
  assert.equal(await status(), "idle");
});
