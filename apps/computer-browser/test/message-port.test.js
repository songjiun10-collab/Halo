"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { BROWSER_PORT, PLANNER_PORT } = require("../shared/port-contracts");
const {
  PortError,
  assertJsonClean,
  createLoopbackPair,
  PortClient,
  serveBrowser,
  servePlanner,
  createRemoteBrowser,
  createRemotePlanner,
} = require("../main/harness/message-port");
const { TaskHost } = require("../main/harness/task-host");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function recordingPair() {
  const wire = [];
  const [a, b] = createLoopbackPair();
  const spy = (side, transport) => {
    const send = transport.send.bind(transport);
    transport.send = (message) => { wire.push({ side, message }); return send(message); };
    return transport;
  };
  return { client: spy("client", a), server: spy("server", b), wire };
}

test("port contracts list the methods the harness uses, split by interaction style", () => {
  assert.deepEqual(Object.keys(BROWSER_PORT.requests).sort(), ["dispose", "execute", "fillCredential", "observe", "userNavigate"]);
  assert.deepEqual(BROWSER_PORT.notifications, ["setPermissionMode"]);
  assert.deepEqual([...BROWSER_PORT.mirrors].sort(), ["getBrowserSnapshot", "getDocumentEpoch"]);
  assert.deepEqual(BROWSER_PORT.events, ["onChange"]);
  assert.deepEqual(Object.keys(PLANNER_PORT.requests).sort(), ["close", "next"]);
  assert.deepEqual(PLANNER_PORT.notifications, ["warm"]);
  assert.equal(BROWSER_PORT.requests.observe.signalArg, 0);
  assert.equal(BROWSER_PORT.requests.execute.signalArg, 1);
  assert.equal(PLANNER_PORT.requests.next.signalArg, 1);
  assert.ok(Object.isFrozen(BROWSER_PORT) && Object.isFrozen(BROWSER_PORT.requests));
});

test("assertJsonClean accepts plain JSON and rejects everything JSON.stringify would silently distort", () => {
  assertJsonClean({ a: [1, "x", null, true, { b: 2.5 }] });
  assertJsonClean({ dropped: undefined, kept: 1 });
  const cyclic = {}; cyclic.self = cyclic;
  for (const bad of [() => {}, Symbol("s"), 10n, NaN, Infinity, new Date(), new Map(), new Set(), new (class Foo {})(), cyclic, [undefined], { nested: { fn() {} } }, Buffer.from("x")]) {
    assert.throws(() => assertJsonClean(bad), (e) => e instanceof PortError && e.code === "non_serializable", String(bad));
  }
});

test("loopback delivers only JSON copies and never shares object identity", async () => {
  const [a, b] = createLoopbackPair();
  const received = [];
  b.onMessage((m) => received.push(m));
  const original = { n: { deep: [1, 2] } };
  a.send(original);
  await tick();
  assert.deepEqual(received, [original]);
  assert.notEqual(received[0], original);
  assert.notEqual(received[0].n, original.n);
});

test("loopback rejects a non-serialisable message at send", () => {
  const [a] = createLoopbackPair();
  assert.throws(() => a.send({ f() {} }), (e) => e.code === "non_serializable");
});

test("loopback buffers messages sent before the peer registers a handler", async () => {
  const [a, b] = createLoopbackPair();
  a.send({ early: true });
  await tick();
  const received = [];
  b.onMessage((m) => received.push(m));
  await tick();
  assert.deepEqual(received, [{ early: true }]);
});

test("a request round-trips and a thrown error keeps its code", async () => {
  const { client, server } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({
    observe: async (options) => ({ id: "obs", initial: options.initial }),
    execute: async () => { const e = new Error("boom"); e.code = "some_code"; throw e; },
  }, server);
  const ok = await port.call("observe", [{ initial: true }]);
  assert.deepEqual(ok, { ok: true, result: { id: "obs", initial: true } });
  const failed = await port.call("execute", [{ type: "click" }, {}]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "some_code");
  assert.equal(failed.message, "boom");
});

test("a call that outlives its timeout resolves { ok:false, code:'timeout' } and cancels the far side", async () => {
  const { client, server } = recordingPair();
  const port = new PortClient(client, { defaultTimeoutMs: 20 });
  let farSignal = null;
  serveBrowser({
    observe: (options) => new Promise((resolve, reject) => {
      farSignal = options.signal;
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  }, server);
  const result = await port.call("observe", [{}]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
  await tick(); await tick();
  assert.equal(farSignal.aborted, true);
});

test("aborting the caller's signal sends a cancel and resolves { ok:false, code:'aborted' }", async () => {
  const { client, server, wire } = recordingPair();
  const port = new PortClient(client);
  let farSignal = null;
  serveBrowser({ observe: (options) => new Promise(() => { farSignal = options.signal; }) }, server);
  const controller = new AbortController();
  const pending = port.call("observe", [{}], { signal: controller.signal });
  await tick();
  controller.abort();
  const result = await pending;
  assert.deepEqual([result.ok, result.code], [false, "aborted"]);
  await tick(); await tick();
  assert.equal(farSignal.aborted, true);
  assert.ok(wire.some((w) => w.side === "client" && w.message.type === "cancel"));
});

test("a pre-aborted signal never sends the request", async () => {
  const { client, server, wire } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({ observe: async () => ({}) }, server);
  const controller = new AbortController(); controller.abort();
  const result = await port.call("observe", [{}], { signal: controller.signal });
  assert.equal(result.code, "aborted");
  assert.equal(wire.filter((w) => w.message.type === "request").length, 0);
});

test("cancel is idempotent and a cancel for an unknown id is ignored", async () => {
  const { client, server } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({ observe: async () => ({ ok: 1 }) }, server);
  client.send({ type: "cancel", id: "nope" });
  client.send({ type: "cancel", id: "nope" });
  await tick();
  assert.deepEqual(await port.call("observe", [{}]), { ok: true, result: { ok: 1 } });
});

test("non-serialisable arguments fail at the caller without sending anything", async () => {
  const { client, server, wire } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({ observe: async () => ({}) }, server);
  const result = await port.call("execute", [{ type: "x", cb() {} }, {}]);
  assert.deepEqual([result.ok, result.code], [false, "non_serializable"]);
  assert.equal(wire.filter((w) => w.message.type === "request").length, 0);
});

test("a non-serialisable result becomes a non_serializable error reply, not corrupted data", async () => {
  const { client, server } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({ observe: async () => ({ id: "obs", node: new Map() }) }, server);
  const result = await port.call("observe", [{}]);
  assert.deepEqual([result.ok, result.code], [false, "non_serializable"]);
});

test("unknown and disallowed methods are refused by the server", async () => {
  const { client, server } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({ observe: async () => ({}), constructor_: () => {}, toString: () => "x" }, server);
  assert.equal((await port.call("constructor_", [])).code, "unknown_method");
  assert.equal((await port.call("toString", [])).code, "unknown_method");
  assert.equal((await port.call("dispose", [])).code, "unsupported_method");
});

test("closing the transport resolves in-flight and later calls with peer_closed", async () => {
  const { client, server } = recordingPair();
  const port = new PortClient(client);
  serveBrowser({ observe: () => new Promise(() => {}) }, server);
  const inFlight = port.call("observe", [{}]);
  await tick();
  client.close();
  assert.equal((await inFlight).code, "peer_closed");
  assert.equal((await port.call("observe", [{}])).code, "peer_closed");
});

test("remote browser exposes the shape TaskController uses, with state mirrored from replies and change events", async () => {
  const { client, server } = recordingPair();
  const listeners = new Set();
  let epoch = 1;
  const local = {
    observe: async () => ({ id: "obs", documentEpoch: epoch }),
    execute: async (action, options) => ({ status: "ok", echoed: action.type, epoch: options.documentEpoch }),
    getDocumentEpoch: () => epoch,
    getBrowserSnapshot: () => ({ activeTabId: "t1", epoch }),
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    setPermissionMode: (mode) => { local.mode = mode; },
    dispose: async () => { local.disposed = true; },
  };
  const served = serveBrowser(local, server);
  const remote = createRemoteBrowser(client);
  const seen = [];
  const unsubscribe = remote.onChange((snapshot) => seen.push(snapshot));

  const observation = await remote.observe({ signal: undefined, initial: true });
  assert.equal(observation.id, "obs");
  assert.equal(remote.getDocumentEpoch(), 1);
  assert.deepEqual(remote.getBrowserSnapshot(), { activeTabId: "t1", epoch: 1 });

  const executed = await remote.execute({ type: "click" }, { signal: undefined, documentEpoch: 1 });
  assert.deepEqual(executed, { status: "ok", echoed: "click", epoch: 1 });

  epoch = 2;
  for (const listener of listeners) listener({ activeTabId: "t1", epoch: 2 });
  await tick(); await tick();
  assert.deepEqual(seen, [{ activeTabId: "t1", epoch: 2 }]);
  assert.deepEqual(remote.getBrowserSnapshot(), { activeTabId: "t1", epoch: 2 });
  assert.equal(remote.getDocumentEpoch(), 2);

  remote.setPermissionMode("full");
  await tick(); await tick();
  assert.equal(local.mode, "full");

  unsubscribe();
  for (const listener of listeners) listener({ activeTabId: "t1", epoch: 3 });
  await tick(); await tick();
  assert.equal(seen.length, 1);

  await remote.dispose();
  assert.equal(local.disposed, true);
  served.close();
});

test("a remote failure rejects with a PortError that keeps the far error code", async () => {
  const { client, server } = recordingPair();
  const planner = { next: async () => { const e = new Error("no worker"); e.code = "planner_unavailable"; throw e; } };
  servePlanner(planner, server);
  const remote = createRemotePlanner(client);
  await assert.rejects(() => remote.next({ taskId: "t" }, { signal: undefined }), (e) => e instanceof PortError && e.code === "planner_unavailable" && e.message === "no worker");
});

test("remote planner warm is fire-and-forget and swallows far failures", async () => {
  const { client, server } = recordingPair();
  let warmed = 0;
  servePlanner({ next: async () => ({}), warm: () => { warmed += 1; throw new Error("cold"); } }, server);
  const remote = createRemotePlanner(client);
  assert.doesNotThrow(() => remote.warm());
  await tick(); await tick();
  assert.equal(warmed, 1);
});

test("the wire carries only JSON: every message equals its own JSON round trip and holds no signals or functions", async () => {
  const { client, server, wire } = recordingPair();
  serveBrowser({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), getDocumentEpoch: () => 1 }, server);
  const remote = createRemoteBrowser(client);
  await remote.observe({ signal: new AbortController().signal, initial: true });
  await remote.execute({ type: "click" }, { signal: new AbortController().signal, documentEpoch: 1 });
  assert.ok(wire.length >= 4);
  for (const { message } of wire) {
    assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
    assert.equal(JSON.stringify(message).includes("signal"), false);
  }
});

test("a TaskHost task runs end to end with browser and planner reachable only through loopback ports", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-ports-"));
  const wire = [];
  const executed = [];
  const plannerContexts = [];
  const closers = [];

  const localBrowser = {
    observe: async () => ({ id: "obs", url: "https://example.com/", elements: [{ id: "button1", role: "button", name: "Go" }] }),
    execute: async (action) => { executed.push(action); return { status: "ok" }; },
    getDocumentEpoch: () => 1,
    getBrowserSnapshot: () => ({ activeTabId: "t1", tabs: [{ id: "t1", url: "https://example.com/" }] }),
    onChange: () => () => {},
    dispose: async () => {},
  };
  let plannerCalls = 0;
  const localPlanner = {
    next: async (context) => {
      plannerContexts.push(context);
      plannerCalls += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [] };
      return plannerCalls === 1
        ? { ...base, kind: "actions", actions: [{ type: "click", elementId: "button1", source: "user_prompt" }] }
        : { ...base, kind: "finish", evidenceIds: [] };
    },
    close: async () => {},
  };

  const wired = (serve, make, local) => () => {
    const pair = recordingPair();
    const origClient = pair.client.send.bind(pair.client);
    pair.client.send = (m) => { wire.push(m); return origClient(m); };
    const origServer = pair.server.send.bind(pair.server);
    pair.server.send = (m) => { wire.push(m); return origServer(m); };
    closers.push(serve(local, pair.server));
    return make(pair.client);
  };

  const host = new TaskHost({
    storageRoot,
    makeBrowser: wired(serveBrowser, createRemoteBrowser, localBrowser),
    makePlanner: wired(servePlanner, createRemotePlanner, localPlanner),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    permissionMode: "full",
  });
  try {
    const { taskId } = await host.createTask({ originalRequest: "click the button through the ports" });
    const deadline = Date.now() + 5000;
    let summary;
    while (Date.now() < deadline) {
      summary = (await host.listTasks()).find((item) => item.taskId === taskId);
      if (summary && ["completed", "awaiting_verification", "paused", "stopped"].includes(summary.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(["completed", "awaiting_verification"].includes(summary.state), JSON.stringify(summary));
    assert.equal(executed.length, 1);
    assert.equal(executed[0].type, "click");
    assert.equal(plannerCalls, 2);
    const methods = wire.filter((m) => m.type === "request").map((m) => m.method);
    assert.ok(methods.includes("observe") && methods.includes("execute") && methods.includes("next"), methods.join(","));
    for (const message of wire) assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
  } finally {
    await host.close();
    for (const c of closers) c.close?.();
  }
});
