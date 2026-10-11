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
const { openCdpView, createCdpView, connectCdpTransport, mergeRequestHeaders, modifierMask, keyInfo, pngSize } = require("../main/harness/cdp-web-contents");
const { createRequestSigner, verifyWebBotAuthHeaders } = require("../main/harness/web-bot-auth");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { makeIntentLock } = require("../shared/harness-contracts");

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

test("signature headers merge over the request's own headers, replacing stale ones", () => {
  const merged = mergeRequestHeaders(
    { accept: "text/html", "user-agent": "Halo", "Signature-Input": "sig1=old", Cookie: "a=b" },
    { "Signature-Input": "sig1=new", Signature: "sig1=:x:", "Signature-Agent": '"https://agent.example.org"' },
  );
  assert.deepEqual(merged, [
    { name: "accept", value: "text/html" },
    { name: "user-agent", value: "Halo" },
    { name: "Cookie", value: "a=b" },
    { name: "Signature-Input", value: "sig1=new" },
    { name: "Signature", value: "sig1=:x:" },
    { name: "Signature-Agent", value: '"https://agent.example.org"' },
  ]);
  assert.deepEqual(mergeRequestHeaders(undefined, { Signature: "sig1=:x:" }), [{ name: "Signature", value: "sig1=:x:" }]);
  assert.deepEqual(
    mergeRequestHeaders([{ name: "Accept", value: "a" }, { name: "signature", value: "old" }], { Signature: "sig1=:new:" }),
    [{ name: "Accept", value: "a" }, { name: "Signature", value: "sig1=:new:" }],
  );
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
  const adapter = new BrowserAdapter({ view });

  const navigated = await adapter.execute({ type: "navigate", url: `${base}/` });
  assert.equal(navigated.status, "ok");
  adapter.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_origins", origins: [base] }] }));
  await view.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${base}/blocked-by-lock`)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(view.webContents.getURL(), `${base}/`, "page-driven top-level navigation obeys the same host lock as agent actions");
  adapter.setIntentLock(null);
  // Re-establish a settled document after Chromium reports the rejected
  // provisional navigation. It must not contaminate the next observation's epoch.
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/` })).status, "ok");
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

test("Web Bot Auth headers reach the server and verify without dropping request headers", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "text/html");
    response.end("<title>signed</title>signed");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-wba-"));
  const signer = await createRequestSigner({ keyFile: path.join(dir, "key.pem"), directoryUrl: "https://agent.example.org" });
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM });
  t.after(async () => {
    await launched.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const transport = await connectCdpTransport(launched.wsUrl);
  t.after(() => transport.close());
  const view = createCdpView(async () => transport, { isolated: true, signRequestHeaders: (url) => signer.sign(url) });
  const adapter = new BrowserAdapter({ view });
  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/page` })).status, "ok");
  const document = seen.find((entry) => entry.url === "/page");
  assert.ok(document, "the document request reached the server");
  assert.ok(document.headers["user-agent"], "existing request headers survive the override");
  assert.equal(document.headers["signature-agent"], '"https://agent.example.org"');
  assert.ok(verifyWebBotAuthHeaders({ url: `${base}/page`, headers: document.headers, publicJwk: signer.publicJwk }), "the server-visible signature verifies");
  await adapter.dispose();
});
