"use strict";

// Disposable loopback-only interaction verification. No model/provider calls.
const { app, BrowserWindow, WebContentsView } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { makeIntentLock } = require("../shared/harness-contracts");

const html = `<!doctype html><meta charset="utf-8"><title>HALO interactions fixture</title>
<form aria-label="Profile" action="/saved" method="post">
<label for="title">Title</label><input id="title" name="title">
<label for="password">Password</label><input id="password" type="password">
<button id="save" type="button">Save draft</button><button type="submit">Submit profile</button>
</form><output id="events"></output>
<script>
window.events=[];
for(const name of ['beforeinput','input','change']) document.getElementById('title').addEventListener(name,()=>window.events.push(name));
document.getElementById('save').addEventListener('click',()=>{window.events.push('click');document.getElementById('events').textContent='DRAFT_SAVED';});
// Main-world prototype poisoning must not alter the host's isolated action.
HTMLElement.prototype.click=()=>{throw Error('page monkey patch');};
</script>`;

async function main() {
  await app.whenReady();
  let postCount = 0, posted = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/saved") {
      req.setEncoding("utf8"); req.on("data", chunk => { posted += chunk; });
      req.on("end", () => { postCount += 1; res.end("<!doctype html><title>Saved</title><p>PROFILE_SAVED</p>"); });
    } else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const browser = new BrowserAdapter({ view, permissionMode: "full" });
  const results = [];
  async function observed(type, name, extra = {}) {
    const obs = await browser.observe();
    const el = obs.elements.find(entry => entry.name === name &&
      (type !== "type" || ["textbox", "searchbox"].includes(entry.role)));
    assert.ok(el, name); return { action: { type, elementId: el.elementId, ...extra }, documentEpoch: obs.documentEpoch };
  }
  async function execute(binding) { return browser.execute(binding.action, { documentEpoch: binding.documentEpoch }); }
  try {
    assert.equal((await browser.execute({ type: "navigate", url: base })).status, "ok");
    const typed = await execute(await observed("type", "Title", { text: "한글 HALO test" }));
    assert.equal(typed.status, "ok", JSON.stringify(typed));
    assert.equal(await view.webContents.executeJavaScript("document.getElementById('title').value"), "한글 HALO test");
    results.push({ case: "native_input", status: typed.status });
    const clicked = await execute(await observed("click", "Save draft"));
    assert.equal(clicked.status, "ok");
    assert.equal(await view.webContents.executeJavaScript("document.getElementById('events').textContent"), "DRAFT_SAVED");
    assert.deepEqual(await view.webContents.executeJavaScript("window.events"), ["beforeinput", "input", "change", "click"]);
    results.push({ case: "isolated_click", status: clicked.status });
    const stale = await observed("click", "Save draft");
    await view.webContents.executeJavaScript("document.getElementById('save').outerHTML='<button id=save type=button>Save draft</button>'");
    assert.equal((await execute(stale)).errorCode, "stale_element");
    results.push({ case: "dom_replacement", status: "blocked" });
    assert.equal((await execute(await observed("type", "Password", { text: "never_written" }))).errorCode, "unsupported_input");
    results.push({ case: "password_field", status: "blocked" });
    const locked = await observed("submit_form", "Submit profile");
    browser.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_action", action: "submit_form" }] }));
    assert.equal((await execute(locked)).errorCode, "intent_lock_denied");
    assert.equal(postCount, 0); browser.setIntentLock(null);
    results.push({ case: "intent_lock", status: "blocked" });
    const submit = await observed("submit_form", "Submit profile");
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("form navigation timed out")), 5000);
      view.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    });
    const submitted = await execute(submit); await loaded;
    assert.ok(["ok", "uncertain"].includes(submitted.status));
    assert.equal(postCount, 1);
    assert.equal(new URLSearchParams(posted).get("title"), "한글 HALO test");
    assert.match(await view.webContents.executeJavaScript("document.body.textContent"), /PROFILE_SAVED/);
    await execute(submit); assert.equal(postCount, 1);
    results.push({ case: "native_form_post_once", status: submitted.status, postCount });
    return { real: true, loopbackOnly: true, results };
  } finally {
    await browser.dispose(); window.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

main().then(result => { console.log(`RESULT_JSON:${JSON.stringify(result)}`); app.exit(0); })
  .catch(error => { console.error(error); app.exit(1); });
