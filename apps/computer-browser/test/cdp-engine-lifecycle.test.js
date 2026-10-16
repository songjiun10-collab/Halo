"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { CdpSession } = require("../main/harness/chromium-session");

// Replace only external browser launch/transport and page creation. The engine
// and cookie-session implementation remain real; delayed providers expose races.
function fixture({ attachFails = false, attachGate = null } = {}) {
  const launches = [];
  const transports = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../main/harness/cdp-engine"), "utf8"), {
    module, exports: module.exports,
    require(name) {
      if (name === "./chromium-session") return { CdpSession };
      if (name === "./cdp-browser-host") return { async acquireCdpBrowser(options) {
        const entry = { options, closes: 0, wsUrl: `ws://browser-${launches.length}` };
        launches.push(entry);
        return { wsUrl: entry.wsUrl, async close() { entry.closes++; } };
      } };
      if (name === "./cdp-web-contents") return {
        async connectCdpTransport(url) {
          if (attachGate) await attachGate;
          if (attachFails) throw new Error("attach_failed");
          const transport = { url, closed: false, calls: [], contexts: 0,
            async send(method, params) {
              if (this.closed) throw new Error("transport_closed");
              this.calls.push({ method, params });
              if (method === "Target.createBrowserContext") return { browserContextId: `${url}/context-${++this.contexts}` };
              if (method === "Storage.getCookies") return { cookies: [{ name: "owner", value: url, domain: "example.test", expires: -1 }] };
              return {};
            }, close() { this.closed = true; } };
          transports.push(transport); return transport;
        },
        createCdpView(provider, options) {
          const wc = new EventEmitter();
          wc.session = options.session;
          wc.close = () => wc.emit("destroyed");
          return { webContents: wc, async observe() {
            const transport = await provider();
            await options.sharedContext(transport);
            if (transport.closed) throw new Error("transport_closed");
            return transport.url;
          } };
        },
      };
      throw new Error(`unexpected dependency ${name}`);
    },
  });
  return { engine: new module.exports.CdpEngine(), launches, transports };
}
const config = (path) => ({ browserEngine: "chromium", chromiumPath: path });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("settings changes preserve active pages until the last old page closes", async () => {
  const { engine, launches } = fixture();
  engine.configure(config("/old"));
  const first = engine.createPage("agent-a");
  const sibling = engine.createPage("agent-b");
  assert.equal(await first.observe(), "ws://browser-0");
  await sibling.observe();
  engine.configure(config("/new"));
  await tick();
  assert.equal(launches[0].closes, 0, "a settings update must not terminate running work");
  assert.equal(await first.observe(), "ws://browser-0");
  assert.equal(await engine.createPage("agent-c").observe(), "ws://browser-1");
  first.webContents.close(); await tick();
  assert.equal(launches[0].closes, 0);
  sibling.webContents.close(); await tick();
  assert.equal(launches[0].closes, 1, "retired browser is reclaimed at zero pages");
  await engine.release();
  assert.equal(launches[1].closes, 1);
});

test("a delayed page and its session stay pinned to their creation settings", async () => {
  const { engine, launches } = fixture();
  engine.configure(config("/old"));
  const old = engine.createPage("agent-a");
  engine.configure(config("/new"));
  assert.equal(await old.observe(), "ws://browser-0");
  assert.equal(launches[0].options.executablePath, "/old");
  assert.equal((await old.webContents.session.cookies.get())[0].value, "ws://browser-0");
  await engine.createPage("agent-a").observe();
  assert.equal(launches[1].options.executablePath, "/new");
  await engine.release();
});

test("a standalone session cannot silently reconnect through newer settings", async () => {
  const { engine } = fixture();
  engine.configure(config("/old"));
  const old = engine.sessionFor("agent-a");
  await old.cookies.get();
  engine.configure(config("/new"));
  await assert.rejects(old.cookies.get(), /generation_released/);
  await engine.release();
});

test("failed CDP attachment closes the browser and permits a later attempt", async () => {
  const { engine, launches } = fixture({ attachFails: true });
  engine.configure(config("/old"));
  await assert.rejects(engine.createPage("agent-a").observe(), /attach_failed/);
  assert.equal(launches[0].closes, 1, "the launched browser must not leak on attach failure");
  await assert.rejects(engine.createPage("agent-b").observe(), /attach_failed/);
  assert.equal(launches.length, 2);
  await engine.release();
});

test("release invalidates unopened page providers rather than resurrecting a browser", async () => {
  const { engine, launches } = fixture();
  engine.configure(config("/old"));
  const page = engine.createPage("agent-a");
  await engine.release();
  await assert.rejects(page.observe(), /generation_released/);
  assert.equal(launches.length, 0);
});

test("release during attachment drains and closes the pending browser exactly once", async () => {
  let finishAttach;
  const attachGate = new Promise((resolve) => { finishAttach = resolve; });
  const { engine, launches, transports } = fixture({ attachGate });
  engine.configure(config("/old"));
  const observing = engine.createPage("agent-a").observe();
  const rejected = assert.rejects(observing, /generation_released/);
  await tick();
  let drained = false;
  const release = engine.release().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false, "shutdown must wait for the pending connection to clean up");
  finishAttach();
  await Promise.all([release, rejected]);
  assert.equal(launches[0].closes, 1);
  assert.equal(transports[0].closed, true);
  await engine.release();
  assert.equal(launches[0].closes, 1);
});

test("unchanged settings retain the live connection and concurrent pages share one partition context", async () => {
  const { engine, launches, transports } = fixture();
  engine.configure(config("/old"));
  const first = engine.createPage("agent-a");
  await first.observe();
  engine.configure(config("/old"));
  await Promise.all([first.observe(), engine.createPage("agent-a").observe()]);
  assert.equal(launches.length, 1);
  assert.equal(transports[0].contexts, 1);
  await engine.release();
});
