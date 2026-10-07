"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { createSessionVault } = require("../main/harness/session-vault");

const AGENT = "persist:halo-agent-123e4567-e89b-12d3-a456-426614174000";
const COOKIE = { name: "sid", value: "abc", domain: "127.0.0.1", path: "/", expires: -1 };

function setup({ vault, loadError = false, setCookiesError = false } = {}) {
  const calls = [];
  const order = [];
  let n = 0;
  const transport = {
    close() {},
    async send(method, params) {
      calls.push({ method, params });
      order.push(method);
      if (method === "Target.createBrowserContext") return { browserContextId: `ctx-${++n}` };
      if (method === "Storage.getCookies") return { cookies: [COOKIE] };
      if (method === "Storage.setCookies" && setCookiesError) throw new Error("boom");
      return {};
    },
  };
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium" });
  const generation = engine.currentGeneration();
  generation.connection = Promise.resolve({ transport, close: async () => { order.push("close"); } });
  const fakeVault = vault === undefined ? {
    saved: [],
    isPersistentPartition: (p) => p.startsWith("persist:halo-agent-"),
    async load() { if (loadError) throw new Error("load failed"); return [COOKIE]; },
    async save(partition, cookies) { order.push("vault.save"); this.saved.push({ partition, cookies }); return true; },
  } : vault;
  if (fakeVault) engine.setSessionVault(fakeVault);
  return { engine, generation, transport, calls, order, vault: fakeVault };
}

test("a persistent agent context is restored from the vault", async () => {
  const { engine, generation, transport, calls } = setup();
  const id = await engine.contextFor(generation, AGENT, transport);
  assert.equal(id, "ctx-1");
  const set = calls.filter((c) => c.method === "Storage.setCookies");
  assert.equal(set.length, 1);
  assert.deepEqual(set[0].params, { cookies: [COOKIE], browserContextId: "ctx-1" });
  await engine.release();
});

test("ordinary and child partitions are not restored", async () => {
  const { engine, generation, transport, calls } = setup();
  await engine.contextFor(generation, "halo-task-1", transport);
  await engine.contextFor(generation, "halo-child-1", transport);
  assert.equal(calls.filter((c) => c.method.startsWith("Storage.")).length, 0);
  await engine.release();
});

test("release saves cookies before the browser closes", async () => {
  const { engine, generation, transport, order, vault } = setup();
  await engine.contextFor(generation, AGENT, transport);
  await engine.release();
  assert.ok(order.indexOf("vault.save") > -1);
  assert.ok(order.indexOf("vault.save") < order.indexOf("close"));
  assert.deepEqual(vault.saved, [{ partition: AGENT, cookies: [COOKIE] }]);
});

test("without a vault there are no Storage calls", async () => {
  const { engine, generation, transport, calls } = setup({ vault: null });
  await engine.contextFor(generation, AGENT, transport);
  await engine.saveSessions();
  await engine.release();
  assert.equal(calls.filter((c) => c.method.startsWith("Storage.")).length, 0);
  assert.equal(engine.saveTimer, null);
});

test("a restore failure still yields the context id", async () => {
  for (const options of [{ loadError: true }, { setCookiesError: true }]) {
    const { engine, generation, transport } = setup(options);
    assert.equal(await engine.contextFor(generation, AGENT, transport), "ctx-1");
    await engine.release();
  }
});

test("the periodic save timer is unref'd and gone after release", async () => {
  const { engine, generation, transport } = setup();
  assert.equal(engine.saveTimer, null);
  await engine.contextFor(generation, AGENT, transport);
  assert.ok(engine.saveTimer);
  assert.equal(engine.saveTimer.hasRef(), false);
  await engine.release();
  assert.equal(engine.saveTimer, null);
});

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find((p) => p && fs.existsSync(p));

test("a login cookie survives release and a fresh engine", { skip: !CHROMIUM && "no Chromium binary", timeout: 120000 }, async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.cookie || "");
    res.setHeader("content-type", "text/html");
    res.setHeader("set-cookie", "sid=abc; Max-Age=3600; Path=/");
    res.end("<!doctype html><title>v</title>ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-vault-"));
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString(),
  };
  const engines = [];
  t.after(async () => {
    for (const e of engines) await e.release().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = async () => {
    const engine = new CdpEngine();
    engines.push(engine);
    engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
    engine.setSessionVault(createSessionVault({ dir, storage }));
    const page = engine.createPage(AGENT);
    await page.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
    return { engine, page };
  };
  const first = await open();
  assert.equal(seen[0], "");
  await first.engine.release();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".session"));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(dir, files[0])).toString().includes("abc"));
  const second = await open();
  assert.match(seen[1], /sid=abc/);
  await second.engine.release();
  try {
    const left = execFileSync("ps", ["aux"], { encoding: "utf8" }).split("\n").filter((l) => l.includes("Chromium.app/Contents/MacOS") && l.includes(dir));
    assert.deepEqual(left, []);
  } catch (error) { if (error.name === "AssertionError") throw error; }
});
