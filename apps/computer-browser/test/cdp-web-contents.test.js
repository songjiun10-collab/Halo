"use strict";

// Integration: the real BrowserAdapter driving a real Chromium over CDP.
// Skipped unless a Chromium binary is found (HALO_CHROMIUM or the local trial build).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { openCdpView, createCdpView, connectCdpTransport, modifierMask, keyInfo, pngSize } = require("../main/harness/cdp-web-contents");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");

// A profile Chromium is still writing to can refuse removal for a moment. Failing the test over a temp
// directory would hide the result; the OS cleans /tmp anyway.
function removeProfile(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
  }
}

// Chromium writes its profile while it shuts down: ask nicely, then force it, and only return once the
// process is gone, so removing the profile directory afterwards cannot race it.
function stopChromium(chrome) {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forced = setTimeout(() => chrome.kill("SIGKILL"), 5000);
    chrome.once("exit", () => { clearTimeout(forced); resolve(); });
    chrome.kill("SIGTERM");
  });
}

const CANDIDATES = [
  process.env.HALO_CHROMIUM,
  path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"),
].filter(Boolean);
const CHROMIUM = CANDIDATES.find((candidate) => fs.existsSync(candidate));

test("pure helpers map modifiers, keys and PNG headers", () => {
  assert.equal(modifierMask(["shift", "control"]), 10);
  assert.equal(modifierMask(undefined), 0);
  assert.deepEqual(keyInfo("Enter"), { key: "Enter", code: "Enter", vk: 13, text: "\r" });
  assert.equal(keyInfo("a").code, "KeyA");
  const header = Buffer.alloc(24);
  header.write("\x89PNG", 0, "latin1");
  header.writeUInt32BE(300, 16);
  header.writeUInt32BE(200, 20);
  assert.deepEqual(pngSize(header), { width: 300, height: 200 });
  assert.deepEqual(pngSize(Buffer.alloc(4)), { width: 0, height: 0 });
});

test("BrowserAdapter observes, clicks and navigates a real Chromium page over CDP", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/next") response.end("<title>Next</title><p>DONE-XYZ</p>");
    else response.end('<title>Start</title><h1>Hello</h1><a id="go" href="/next">Go next</a>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
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
  const adapter = new BrowserAdapter({ view });

  const navigated = await adapter.execute({ type: "navigate", url: `${base}/` });
  assert.equal(navigated.status, "ok");
  const first = await adapter.observe();
  assert.ok(first.elements.some((element) => element.name === "Hello"), "heading observed");
  const link = first.elements.find((element) => /Go next/.test(element.name ?? element.text ?? ""));
  assert.ok(link, "link element observed");

  const followed = await adapter.execute({ type: "follow_link", elementId: link.elementId }, { documentEpoch: first.documentEpoch });
  assert.equal(followed.status, "ok");
  const second = await adapter.observe();
  assert.match(`${second.text} ${second.elements.map((element) => element.name ?? "").join(" ")}`, /DONE-XYZ/);
  assert.ok(second.documentEpoch > first.documentEpoch);

  const stale = await adapter.execute({ type: "scroll", direction: "down", amount: 100 }, { documentEpoch: first.documentEpoch });
  assert.equal(stale.errorCode, "stale_document", "an action from an old epoch is rejected");

  // Input path through the WebContents-shaped surface the adapter calls.
  const wc = view.webContents;
  await wc.executeJavaScript(`document.body.innerHTML = '<form onsubmit="document.title=\\'submitted:\\'+q.value;return false"><input id="q" style="position:fixed;left:20px;top:20px;width:300px;height:30px"></form>'`);
  wc.sendInputEvent({ type: "mouseMove", x: 100, y: 35 });
  wc.sendInputEvent({ type: "mouseDown", x: 100, y: 35, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: 100, y: 35, button: "left", clickCount: 1 });
  wc.selectAll();
  wc.insertText("halo");
  wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  wc.sendInputEvent({ type: "char", keyCode: "Enter" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await wc.executeJavaScript("({ value: document.getElementById('q').value, title: document.title })");
    if (state.title === "submitted:halo") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.deepEqual(state, { value: "halo", title: "submitted:halo" });

  const shot = await view.webContents.capturePage({ x: 0, y: 0, width: 900, height: 600 });
  assert.deepEqual(shot.getSize(), { width: 900, height: 600 });
  await adapter.dispose();
});

test("several agents share one Chromium with isolated pages, storage and epochs", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<title>${request.url}</title><h1>page ${request.url}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let transport;
  t.after(async () => {
    try { transport?.close(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
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
  transport = await connectCdpTransport(wsUrl);
  const views = await Promise.all([0, 1, 2].map(() => openCdpView(transport, { width: 640, height: 480, isolated: true })));
  const adapters = views.map((view) => new BrowserAdapter({ view }));

  const results = await Promise.all(adapters.map((adapter, index) => adapter.execute({ type: "navigate", url: `${base}/agent-${index}` })));
  assert.deepEqual(results.map((result) => result.status), ["ok", "ok", "ok"]);
  const observations = await Promise.all(adapters.map((adapter) => adapter.observe()));
  observations.forEach((observation, index) => {
    assert.equal(observation.url, `${base}/agent-${index}`, "each agent sees only its own page");
    assert.ok(observation.elements.some((element) => element.name === `page /agent-${index}`));
  });

  // Storage is partitioned: a value set by agent 0 is invisible to agent 1.
  await views[0].webContents.executeJavaScript("localStorage.setItem('k', 'agent0'); document.cookie = 'who=0'");
  assert.equal(await views[1].webContents.executeJavaScript("localStorage.getItem('k')"), null);
  assert.equal(await views[1].webContents.executeJavaScript("document.cookie"), "");

  // One agent navigating moves only its own epoch.
  const epochs = adapters.map((adapter) => adapter.getDocumentEpoch());
  await adapters[0].execute({ type: "navigate", url: `${base}/moved` });
  assert.ok(adapters[0].getDocumentEpoch() > epochs[0]);
  assert.equal(adapters[1].getDocumentEpoch(), epochs[1]);
  assert.equal(adapters[2].getDocumentEpoch(), epochs[2]);

  // Closing one agent leaves the others working.
  const destroyed = new Promise((resolve) => views[2].webContents.on("destroyed", resolve));
  await adapters[2].dispose();
  await destroyed;
  const still = await adapters[1].observe();
  assert.equal(still.url, `${base}/agent-1`);
  await adapters[0].dispose();
  await adapters[1].dispose();
});

test("a CDP page gets the same fail-closed policy as the Electron agent view", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    response.setHeader("content-type", "text/html");
    if (request.url === "/popup") response.end("<title>popup</title>popup");
    else response.end(`<title>main</title><a id="dl" href="/file.bin" download>d</a><script>window.__opened = window.open("/popup") === null</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM });
  t.after(async () => { await launched.close(); await new Promise((resolve) => server.close(resolve)); });
  const transport = await connectCdpTransport(launched.wsUrl);
  t.after(() => transport.close());
  // Built synchronously, used immediately: the page is created in the background.
  const view = createCdpView(async () => transport, { isolated: true });
  const adapter = new BrowserAdapter({ view });
  assert.equal(view.webContents.isDestroyed(), false);

  const navigated = await adapter.execute({ type: "navigate", url: `${base}/` });
  assert.equal(navigated.status, "ok");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const targets = (await transport.send("Target.getTargets")).targetInfos.filter((info) => info.type === "page");
  assert.equal(targets.some((info) => /popup/.test(info.url)), false, "popup target was closed");

  // Only http(s) is reachable: a file: navigation is refused by the page's own policy.
  const refused = await adapter.execute({ type: "navigate", url: "file:///etc/hosts" });
  assert.notEqual(refused.status, "ok");

  // Ad hosts are cancelled for subresources.
  const blocked = await view.webContents.executeJavaScript(`fetch("http://googlesyndication.com/x.js").then(() => "loaded", () => "blocked")`);
  assert.equal(blocked, "blocked");
  const plain = await view.webContents.executeJavaScript(`fetch("${base}/ok").then(() => "loaded", () => "blocked")`);
  assert.equal(plain, "loaded");

  // Downloads are denied: the file is never requested to completion into a file the host keeps.
  await view.webContents.executeJavaScript(`document.getElementById("dl").click()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await view.webContents.executeJavaScript("document.title"), "main", "page stays put");
  await adapter.dispose();
});

test("a CDP page pushes live JPEG frames while it paints, and stops on request", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<title>live</title><body style="margin:0"><div id="b" style="width:300px;height:300px;background:#e33"></div>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM });
  t.after(async () => { await launched.close(); await new Promise((resolve) => server.close(resolve)); });
  const transport = await connectCdpTransport(launched.wsUrl);
  t.after(() => transport.close());
  const view = createCdpView(async () => transport, { isolated: true });
  const adapter = new BrowserAdapter({ view });
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/` })).status, "ok");

  const frames = [];
  await view.webContents.startScreencast({ maxWidth: 800, quality: 60 }, (data) => frames.push(data));
  // A repaint after the stream starts must produce a new frame.
  await view.webContents.executeJavaScript(`document.getElementById("b").style.background = "#33e"`);
  const deadline = Date.now() + 8000;
  while (!frames.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(frames.length > 0, "at least one frame arrived");
  assert.equal(Buffer.from(frames[0], "base64").subarray(0, 2).toString("hex"), "ffd8", "frames are JPEG");

  await view.webContents.stopScreencast();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settled = frames.length;
  await view.webContents.executeJavaScript(`document.getElementById("b").style.background = "#3e3"`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(frames.length, settled, "no frames after stop");
  await assert.rejects(view.webContents.startScreencast({ maxWidth: 0, quality: 60 }, () => {}), /invalid_capture_options/);
  await adapter.dispose();
});

test("a JavaScript dialog cannot freeze the page: alert and beforeunload are accepted, confirm and prompt are cancelled, and the planner is told", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/leave") response.end("<title>left</title>LEFT-OK");
    else response.end('<title>dlg</title><h1>Dialog page</h1><script>window.addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "stay?"; })</script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-dialog-"));
  // Chromium refuses to start as root without --no-sandbox (a CI container or sandbox); a normal user needs neither.
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
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
  const adapter = new BrowserAdapter({ view });
  const wc = view.webContents;
  const within = (ms, work) => Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error(`hung more than ${ms} ms`)), ms))]);

  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/` })).status, "ok");
  // Each of these used to leave the evaluation, and every later command, waiting forever.
  assert.equal(await within(5000, wc.executeJavaScript(`alert("hello"); "after-alert"`)), "after-alert");
  assert.equal(await within(5000, wc.executeJavaScript(`confirm("Delete everything?")`)), false, "a confirm is cancelled, never agreed to for the person");
  assert.equal(await within(5000, wc.executeJavaScript(`prompt("Your password?", "x")`)), null, "a prompt is cancelled, nothing is typed into it");
  assert.equal(await within(5000, wc.executeJavaScript("1 + 1")), 2, "the page still answers");

  const observation = await within(5000, adapter.observe());
  assert.deepEqual(observation.dialogs.map((d) => [d.type, d.outcome]), [["alert", "accepted"], ["confirm", "dismissed"], ["prompt", "dismissed"]]);
  assert.equal(observation.dialogs[1].message, "Delete everything?");
  assert.equal((await within(5000, adapter.observe())).dialogs, undefined, "a dialog is reported once");

  // Leaving a page that asks "stay?" is what the navigation meant; it must not block.
  await wc.executeJavaScript("document.body.click()", true);
  assert.equal((await within(10000, adapter.execute({ type: "navigate", url: `${base}/leave` }))).status, "ok");
  assert.match((await within(5000, adapter.observe())).text, /LEFT-OK/);
  await adapter.dispose();
});

test("an open modal dialog is what the planner sees: the inert page behind it is left out and its own buttons are never cut off", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const items = Array.from({ length: 60 }, (_, i) => `<li><a href="/p/${i}">Product ${i}</a> <button>Add ${i}</button></li>`).join("");
  const page = `<title>shop</title><nav><a href="/">Home</a></nav><main><h1>Shop</h1><ul>${items}</ul></main>
    <dialog id="d" aria-label="Cookie settings"><h2>Cookies</h2><button>Accept all</button><button>Reject all</button></dialog>
    <div id="chat" role="dialog" aria-label="Chat"><button>Open chat</button></div>`;
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(page); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-modal-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => { buffer += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 1000, height: 700 });
  const adapter = new BrowserAdapter({ view, permissionMode: "full" });
  const wc = view.webContents;
  const names = (observation) => observation.elements.map((element) => element.name);

  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/` })).status, "ok");
  const before = await adapter.observe();
  assert.equal(before.modalOpen, undefined);
  assert.ok(names(before).includes("Product 0"), "without a modal the page is listed");
  // The page is long, so the element cap is reached before the dialog at the end of the document.
  assert.equal(names(before).includes("Accept all"), false, "(the bug) the dialog's own buttons fall past the element cap");

  await wc.executeJavaScript("document.getElementById('d').showModal()");
  const during = await adapter.observe();
  assert.equal(during.modalOpen, true);
  assert.deepEqual(names(during).filter((name) => /^(Accept all|Reject all)$/.test(name)), ["Accept all", "Reject all"], "the dialog's buttons are listed");
  assert.equal(names(during).some((name) => /^Product \d+$/.test(name) || /^Add \d+$/.test(name)), false, "the page behind the modal is left out");
  assert.ok(during.elements.length < 10, `only the dialog remains (${during.elements.length} elements)`);
  const accept = during.elements.find((element) => element.name === "Accept all");
  assert.equal((await adapter.execute({ type: "click", elementId: accept.elementId }, { documentEpoch: during.documentEpoch })).status, "ok", "the dialog can still be clicked");

  await wc.executeJavaScript("document.getElementById('d').close()");
  const after = await adapter.observe();
  assert.equal(after.modalOpen, undefined, "closing it brings the page back");
  assert.ok(names(after).includes("Product 0"));
  assert.ok(names(after).includes("Open chat") || names(after).includes("Product 0"), "a non-modal role=dialog (a chat widget) never hides the page");
  await adapter.dispose();
});

test("on the person's own tab a dialog waits for the person: it is reported, answered once, and the page carries on", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end("<title>ask</title><p>page</p>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-ask-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => { buffer += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 900, height: 600, dialogs: "ask" });
  const wc = view.webContents;
  const opened = [];
  wc.on("javascript-dialog-opening", (info) => opened.push(info));
  await wc.loadURL(`${base}/`);

  const answer = wc.executeJavaScript(`confirm("Delete this draft?")`);
  for (let i = 0; i < 100 && opened.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(opened.map((d) => [d.type, d.message]), [["confirm", "Delete this draft?"]], "the person is asked");
  assert.deepEqual(wc.takeDialogNotices(), [], "nothing was answered for the person");
  assert.equal(await wc.answerDialog(true), true);
  assert.equal(await answer, true, "the person's OK reaches the page");
  assert.equal(await wc.answerDialog(true), false, "a dialog is answered only once");

  const typed = wc.executeJavaScript(`prompt("Name for the list?", "x")`);
  for (let i = 0; i < 100 && opened.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opened[1].defaultPrompt, "x");
  await wc.answerDialog(true, "Groceries");
  assert.equal(await typed, "Groceries");
});

test("only a modal a person can actually see hides the page; a closed drawer hides nothing; a modal inside a web component lists its buttons", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const body = `<main><h1>Shop</h1><a href="/p/1">Product 1</a><button>Add to cart</button></main>`;
  const pages = {
    "/drawer": `${body}<div role="dialog" aria-modal="true" aria-label="Menu" style="position:fixed;top:0;left:0;width:300px;height:100vh;transform:translateX(-110%)"><a href="/a">Account</a></div>`,
    "/faded": `${body}<div role="dialog" aria-modal="true" aria-label="Menu" style="position:fixed;top:0;left:0;width:300px;height:100vh;opacity:0;pointer-events:none"><a href="/a">Account</a></div>`,
    "/open": `${body}<div role="dialog" aria-modal="true" aria-label="Sign up" style="position:fixed;inset:20% 30%;background:#fff"><button>Subscribe</button><button>No thanks</button></div>`,
    "/shadow": `${body}<x-dialog aria-modal="true" role="dialog" aria-label="Cookies" style="position:fixed;inset:20% 30%;display:block;background:#fff"></x-dialog><script>customElements.define("x-dialog", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<button>Accept all</button><button>Reject all</button>'; } });</script>`,
  };
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(pages[request.url] ?? "<p>none</p>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-modal2-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => { buffer += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 1000, height: 700 });
  const adapter = new BrowserAdapter({ view });
  const look = async (route) => {
    assert.equal((await adapter.execute({ type: "navigate", url: `${base}${route}` })).status, "ok");
    const observation = await adapter.observe();
    return { modalOpen: observation.modalOpen === true, names: observation.elements.map((element) => element.name) };
  };
  for (const route of ["/drawer", "/faded"]) {
    const seen = await look(route);
    assert.equal(seen.modalOpen, false, `${route}: a closed drawer is not an open modal`);
    assert.ok(seen.names.includes("Product 1") && seen.names.includes("Add to cart"), `${route}: the page stays listed`);
  }
  const open = await look("/open");
  assert.equal(open.modalOpen, true);
  assert.ok(open.names.includes("Subscribe") && !open.names.includes("Product 1"), "a visible aria-modal dialog still hides the page behind it");
  const shadow = await look("/shadow");
  assert.equal(shadow.modalOpen, true);
  assert.ok(shadow.names.includes("Accept all") && shadow.names.includes("Reject all"), `the buttons inside the web component are listed: ${JSON.stringify(shadow.names)}`);
  assert.ok(!shadow.names.includes("Product 1"));
  await adapter.dispose();
});

test("on a Chromium agent page a link, a script or a redirect cannot carry the agent somewhere it may not go", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const { makeIntentLock } = require("../shared/harness-contracts");
  let port;
  const pages = {
    "/start": () => `<title>start</title><a id="go" href="http://localhost:${port}/landed">go</a>`,
    "/landed": () => "<title>landed</title><p>landed</p>",
  };
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: `http://localhost:${port}/landed` }); response.end(); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(pages[request.url]?.() ?? "<p>none</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-private-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => { buffer += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 1000, height: 700 });
  const wc = view.webContents;
  const adapter = new BrowserAdapter({ view, permissionMode: "full", blockPrivateNetwork: true });
  adapter.setPrivateNetworkAllowance([base]); // the person named the test server, not localhost
  const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/start` })).status, "ok");
  await wc.executeJavaScript("document.getElementById('go').click()");
  await settle();
  assert.equal(wc.getURL(), `${base}/start`, "(the bug) a link on the page carried the agent to an address the person never named");
  await wc.executeJavaScript(`location.href = ${JSON.stringify(`${other}/landed`)}`);
  await settle();
  assert.equal(wc.getURL(), `${base}/start`, "a script cannot either");
  assert.notEqual((await adapter.execute({ type: "navigate", url: `${base}/redirect` })).status, "ok", "nor a redirect");
  assert.notEqual(wc.getURL(), `${other}/landed`);

  adapter.setPrivateNetworkAllowance([base, other]);
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/redirect` })).status, "ok", "once the person named it, the redirect lands");
  assert.equal(wc.getURL(), `${other}/landed`, "and the load is reported done only once its page is there");

  // The same events carry the Intent Lock: a link to an origin the lock leaves out is stopped too.
  adapter.setIntentLock(makeIntentLock({ rules: [{ kind: "allow_origins", origins: [base] }] }));
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/start` })).status, "ok");
  await wc.executeJavaScript("document.getElementById('go').click()");
  await settle();
  assert.equal(wc.getURL(), `${base}/start`, "the lock holds against a page's own link");
  await adapter.dispose();
});

test("play_loop plays a made-up rhythm game in a real Chromium: notes arrive faster than a planner turn, and the keys land in time", { skip: !CHROMIUM && "no Chromium binary", timeout: 120000 }, async (t) => {
  // Four lanes, a note every 500 ms falling for 1.1 s to a line at 80% height. A key counts as a hit only when
  // that lane's note is within 45 px of the line when it is pressed. A planner call alone cannot do this.
  const LANE_X = [0.2, 0.4, 0.6, 0.8];
  const KEYS = ["d", "f", "j", "k"];
  const game = `<!doctype html><title>made-up rhythm game</title><style>html,body{margin:0;background:#101018;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style>
<canvas id="c" width="1000" height="700"></canvas><script>
const W = 1000, H = 700, LINE = H * 0.8, FALL = 1100, KEYS = ${JSON.stringify(KEYS)}, LANES = ${JSON.stringify(LANE_X)};
const notes = Array.from({ length: 16 }, (_, i) => ({ lane: (i * 3 + (i >> 2)) % 4, at: 1000 + i * 500, hit: false, missed: false }));
const state = window.__game = { hits: 0, misses: 0, falsePresses: 0, pressed: [] };
const yOf = (n, now) => LINE + ((now - n.at) / FALL) * LINE;
const ctx = document.getElementById("c").getContext("2d");
const t0 = performance.now();
addEventListener("keydown", (e) => {
  const lane = KEYS.indexOf(e.key); if (lane < 0 || e.repeat) return;
  const now = performance.now() - t0; state.pressed.push(e.key);
  const note = notes.find((n) => n.lane === lane && !n.hit && !n.missed && Math.abs(yOf(n, now) - LINE) <= 45);
  if (note) { note.hit = true; state.hits += 1; } else state.falsePresses += 1;
});
(function frame() {
  const now = performance.now() - t0;
  ctx.fillStyle = "#101018"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, LINE - 2, W, 4);
  for (const n of notes) {
    const y = yOf(n, now);
    if (!n.hit && !n.missed && y > LINE + 60) { n.missed = true; state.misses += 1; }
    if (n.hit || y < -40 || y > H + 40) continue;
    ctx.fillStyle = "rgb(255,40,40)"; ctx.fillRect(LANES[n.lane] * W - 40, y - 15, 80, 30);
  }
  requestAnimationFrame(frame);
})();
</script>`;
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(game); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-cdp-game-"));
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let view;
  t.after(async () => {
    try { view?.closeConnection(); } catch { /* ignore */ }
    await stopChromium(chrome);
    await new Promise((resolve) => server.close(resolve));
    removeProfile(profile);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    chrome.stderr.on("data", (chunk) => { buffer += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on("exit", () => reject(new Error("Chromium exited early")));
  });
  view = await openCdpView(wsUrl, { width: 1000, height: 700 });
  const wc = view.webContents;
  const adapter = new BrowserAdapter({ view, permissionMode: "interact" });
  assert.equal((await adapter.execute({ type: "navigate", url: base })).status, "ok");
  // The game starts when the page loads; the loop must be running before the first note reaches the line.
  const observation = await adapter.observe();
  adapter.authorizeVisualBinding({ observationId: observation.id, taskId: "22222222-2222-4222-8222-222222222222", agentId: null, documentEpoch: observation.documentEpoch, origin: new URL(base).origin, capturedAt: 1, viewport: { width: 1000, height: 700 }, digest: "0".repeat(64) });
  const lanes = LANE_X.map((x, i) => ({ x, y: 0.8, key: KEYS[i], color: [255, 40, 40], tolerance: 50 }));
  const result = await adapter.execute({ type: "play_loop", observationId: observation.id, seconds: 11, lanes }, { documentEpoch: observation.documentEpoch });
  assert.equal(result.status, "ok", JSON.stringify(result));
  const score = await wc.executeJavaScript("window.__game");
  const report = (await adapter.observe()).playLoop;
  t.diagnostic(`rhythm game: ${score.hits}/16 hit, ${score.misses} missed, ${score.falsePresses} false presses, ${report.total} presses in ${report.seconds}s`);
  assert.ok(score.hits >= 14, `hit ${score.hits} of 16 notes (misses ${score.misses}, false presses ${score.falsePresses}, presses ${score.pressed.join("")})`);
  assert.ok(score.falsePresses <= 2, `false presses ${score.falsePresses}`);
  assert.equal(report.stopped, "time");
  assert.ok(report.total >= 14 && report.total <= 20, `the host pressed ${report.total} times`);
  await adapter.dispose();
});
