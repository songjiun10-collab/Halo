"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRendererBridge } = require("../main/harness/chromium-bridge");
const { createKeychainStorage } = require("../main/harness/chromium-keychain");
const { CdpSession } = require("../main/harness/chromium-session");
const { BrowserSurfaces } = require("../main/harness/browser-surfaces");
const { EventEmitter } = require("node:events");
const { launchFlags } = require("../main/harness/cdp-browser-host");

test("Chromium bridge admits only its authenticated local renderer, and preserves RPC error codes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-ui-"));
  await fs.writeFile(path.join(root, "index.html"), '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'none\'" /></head><body>Halo</body></html>');
  const calls = [];
  const bridge = createRendererBridge({ root, methods: ["navigate"], layout: {}, invoke: async (channel, args) => {
    calls.push([channel, args]);
    if (args[0] === "fail") throw Object.assign(new Error("no access"), { code: "denied" });
    return { ok: true };
  } });
  const { url, origin } = await bridge.start();
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true }); });
  assert.equal((await fetch(`${origin}/rpc`, { method: "POST", body: "{}" })).status, 403);
  const bootstrap = await fetch(url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
  assert.equal(bootstrap.status, 303);
  const page = await fetch(`${origin}/`, { headers: { cookie } });
  const html = await page.text();
  assert.match(html, /halo-bridge\.js/);
  assert.doesNotMatch(html, /connect-src 'none'/, "a page-level CSP must not block the bridge's /rpc and /events");
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  const script = await (await fetch(`${origin}/halo-bridge.js`, { headers: { cookie } })).text();
  const capability = /const capability = "([a-f0-9]+)"/.exec(script)[1];
  const invoke = (args, other = {}) => fetch(`${origin}/rpc`, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-halo-capability": capability, ...other }, body: JSON.stringify({ channel: "halo:navigate", args }) });
  assert.deepEqual(await (await invoke(["https://example.com"])).json(), { result: { ok: true } });
  assert.equal((await invoke([], { origin: "https://attacker.example" })).status, 403);
  assert.equal((await invoke([], { "x-halo-capability": "wrong" })).status, 403);
  const rejected = await invoke(["fail"]);
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { error: { code: "denied", message: "no access" } });
  assert.equal(calls.length, 2);
  assert.equal((await fetch(`${origin}/../package.json`, { headers: { cookie } })).status, 404);
});

test("Chromium bridge carries a voice clip as base64 and keeps every other call at 64 KiB", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-ui-"));
  await fs.writeFile(path.join(root, "index.html"), "<html><body>Halo</body></html>");
  const seen = [];
  const bridge = createRendererBridge({ root, methods: ["navigate", "transcribeAudio"], layout: {}, invoke: async (channel, args) => { seen.push([channel, args]); return { ok: true }; } });
  const { url, origin } = await bridge.start();
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true }); });
  const cookie = (await fetch(url, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
  const script = await (await fetch(`${origin}/halo-bridge.js`, { headers: { cookie } })).text();
  const capability = /const capability = "([a-f0-9]+)"/.exec(script)[1];
  const send = (channel, args, header = channel) => fetch(`${origin}/rpc`, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-halo-capability": capability, "x-halo-channel": header }, body: JSON.stringify({ channel, args }) });
  const clip = Buffer.alloc(200_000, 7);
  const ok = await send("halo:transcribeAudio", [{ __haloBase64: clip.toString("base64") }, { language: "ko" }]);
  assert.equal(ok.status, 200);
  const [, args] = seen.at(-1);
  assert.ok(Buffer.isBuffer(args[0]) && args[0].equals(clip), "the host receives the clip's bytes, not a JSON object");
  assert.deepEqual(args[1], { language: "ko" });
  assert.equal((await send("halo:navigate", ["x".repeat(100_000)])).status, 413, "other calls keep the 64 KiB limit");
  assert.equal((await send("halo:navigate", ["x".repeat(100_000)], "halo:transcribeAudio")).status, 413, "naming the audio channel in the header does not raise another call's limit");
  assert.equal((await send("halo:transcribeAudio", [{ __haloBase64: Buffer.alloc(7 * 1024 * 1024).toString("base64") }])).status, 413, "even a voice clip has a ceiling");
  assert.match(script, /__haloBase64/, "the browser shim encodes binary before sending");
});

test("Chromium encrypted storage authenticates data and never falls back to plaintext", () => {
  const key = Buffer.alloc(32, 7);
  const storage = createKeychainStorage({ readKey: () => key });
  assert.equal(storage.isEncryptionAvailable(), true);
  const data = storage.encryptString("secret Ω");
  assert.equal(storage.decryptString(data), "secret Ω");
  assert.equal(data.includes(Buffer.from("secret")), false);
  const tampered = Buffer.from(data); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => storage.decryptString(tampered));
  assert.throws(() => createKeychainStorage({ readKey: () => { throw new Error("locked"); } }).encryptString("x"));
  assert.throws(() => storage.decryptString(Buffer.from("plain text")), /unsupported_ciphertext/);
});

test("CDP session cookie operations stay inside their assigned browser context", async () => {
  const calls = [];
  const transport = { send: async (method, params, sessionId) => {
    calls.push([method, params, sessionId]);
    if (method === "Storage.getCookies") return { cookies: [{ name: "a", value: "1", domain: ".example.com", path: "/", secure: true }] };
    if (method === "Target.createTarget") return { targetId: "cookie-target" };
    if (method === "Target.attachToTarget") return { sessionId: "cookie-session" };
    return {};
  } };
  const session = new CdpSession(async () => ({ transport, contextId: "agent-a" }));
  await session.cookies.set({ url: "https://example.com/", name: "a", value: "1", sameSite: "no_restriction", secure: true });
  assert.equal((await session.cookies.get({})).length, 1);
  await session.cookies.remove("https://example.com/", "a");
  assert.ok(calls.filter(([method]) => method.startsWith("Storage.") || method === "Target.createTarget").every(([, params]) => params.browserContextId === "agent-a"));
  assert.equal(calls.find(([method]) => method === "Network.deleteCookies")[2], "cookie-session");
  assert.equal(calls.some(([method]) => method === "Storage.clearCookies"), false, "removing one cookie never clears unrelated cookies");
  assert.equal(calls[0][1].cookies[0].sameSite, "None");
  await assert.rejects(session.cookies.set({ url: "file:///etc/passwd", name: "a", value: "x" }));
});

test("Chromium human takeover accepts Unicode composition and rejects malformed input before dispatch", () => {
  const win = new EventEmitter();
  Object.assign(win, { contentView: { addChildView() {}, removeChildView() {} }, isDestroyed: () => false, getContentSize: () => [800, 600] });
  let userOwns = false;
  const surfaces = new BrowserSurfaces(win, { isUserControlled: () => userOwns });
  const wc = new EventEmitter();
  const calls = [];
  Object.assign(wc, { isDestroyed: () => false, insertText: (value) => calls.push(value), sendInputEvent: (value) => calls.push(value) });
  surfaces.register("a", { webContents: wc, setVisible() {}, setBounds() {}, getBounds: () => ({ width: 800, height: 500 }) });
  assert.equal(surfaces.sendInput("a", { type: "insertText", text: "한글 Ω" }), false);
  userOwns = true;
  assert.equal(surfaces.sendInput("a", { type: "insertText", text: "한글 Ω" }), true);
  assert.deepEqual(calls, ["한글 Ω"]);
  assert.throws(() => surfaces.sendInput("a", { type: "mouseDown", nx: Infinity, ny: 0 }), /invalid/);
  assert.throws(() => surfaces.sendInput("a", { type: "keyDown", key: "a", modifiers: ["super"] }), /invalid/);
  assert.throws(() => surfaces.sendInput("a", { type: "insertText", text: "x".repeat(16385) }), /invalid/);
  assert.equal(calls.length, 1);
});

test("the desktop launch preserves installed extensions while agent launch keeps them disabled", () => {
  const desktop = launchFlags(undefined, false, "/private/profile", "/Applications/Chromium", { desktop: true, appUrl: "http://127.0.0.1:8123/" });
  assert.equal(desktop.includes("--disable-extensions"), false);
  assert.ok(desktop.includes("--app=http://127.0.0.1:8123/"));
  const agent = launchFlags(undefined, true, "/private/agent", "/Applications/Chromium");
  assert.ok(agent.includes("--disable-extensions"));
  assert.equal(agent.some((flag) => flag.startsWith("--app=")), false);
  assert.throws(() => launchFlags(undefined, false, "/private/profile", "/Applications/Chromium", { desktop: true, appUrl: "https://attacker.example/" }), /invalid_app_url/);
});

test("the Chromium runtime can be loaded by Node without resolving Electron", () => {
  const { execFileSync } = require("node:child_process");
  const script = `const Module=require('node:module'); const load=Module._load; Module._load=function(name,...args){if(name==='electron')throw new Error('Electron loaded');return load.call(this,name,...args)};process.env.HALO_DESKTOP_RUNTIME='chromium';const desktop=require('./main/desktop-runtime');const {AgentViewportHost}=require('./main/harness/agent-viewport-host');const {ControlApi}=require('./main/control-api');require('./main/ipc');console.log(desktop.isChromium,typeof AgentViewportHost,typeof ControlApi);`;
  assert.equal(execFileSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim(), "true function function");
});
