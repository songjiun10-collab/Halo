"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { CodexAppServer, ENV_KEYS, MAX_FRAME_BYTES } = require("../main/harness/providers/codex-app-server");

function fixture({ timeoutMs = 1000, reply, ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  const kills = [];
  let closed = false;
  const send = (message) => child.stdout.emit("data", Buffer.from(JSON.stringify(message) + "\n"));
  child.stdin.write = (line) => {
    const message = JSON.parse(line);
    writes.push(message);
    if (message.method === "initialize") queueMicrotask(() => send({ id: message.id, result: {} }));
    else if (message.id !== undefined && message.method) reply?.(message, send);
  };
  child.kill = (signal) => {
    kills.push(signal);
    if (ignoreTerm && signal === "SIGTERM") return;
    queueMicrotask(() => { if (!closed) { closed = true; child.emit("close", 0); } });
  };
  let spawned;
  const lifecycle = [];
  const client = new CodexAppServer({ timeoutMs,
    spawnFn: (...args) => { spawned = args; return child; },
    onWorkerStart: (id) => lifecycle.push(["start", id]),
    onWorkerExit: (id) => lifecycle.push(["exit", id]),
  });
  return { client, child, writes, kills, send, lifecycle, spawned: () => spawned };
}

test("initialization is shared and only a fixed argv/environment reaches Codex", async () => {
  const key = "HALO_APPROVER_KEY";
  const saved = process.env[key];
  process.env[key] = "must-not-leak";
  const f = fixture();
  try {
    await Promise.all([f.client.start(), f.client.start()]);
    const [command, args, options] = f.spawned();
    assert.equal(command, "codex");
    assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
    assert.equal(options.shell, false);
    assert.equal(options.env[key], undefined);
    assert.ok(Object.keys(options.env).every((k) => ENV_KEYS.includes(k)));
    assert.equal(f.writes.filter((m) => m.method === "initialize").length, 1);
    assert.equal(f.writes.at(-1).method, "initialized");
    await f.client.close();
    assert.deepEqual(f.lifecycle.map((x) => x[0]), ["start", "exit"]);
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    await f.client.close();
  }
});

test("correlates out-of-order replies and fragmented UTF-8 frames", async () => {
  const f = fixture();
  await f.client.start();
  const first = f.client.request("one", {});
  const second = f.client.request("two", {});
  const [a, b] = f.writes.slice(-2);
  f.send({ id: b.id, result: { value: "second" } });
  const bytes = Buffer.from(JSON.stringify({ id: a.id, result: "한글" }) + "\n");
  for (const byte of bytes) f.child.stdout.emit("data", Buffer.from([byte]));
  assert.equal(await first, "한글");
  assert.deepEqual(await second, { value: "second" });
  await f.client.close();
});

test("denies server permission requests without sending any acceptance", async () => {
  const f = fixture();
  await f.client.start();
  f.send({ id: "approve-1", method: "tool/requestUserInput", params: { questions: [] } });
  const response = f.writes.at(-1);
  assert.equal(response.id, "approve-1");
  assert.equal(response.error.code, -32601);
  assert.equal(response.result, undefined);
  await f.client.close();
});

test("bounded pending requests reject excess work before writing", async () => {
  const f = fixture();
  await f.client.start();
  const pending = Array.from({ length: 4 }, () => f.client.request("pending", {}));
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(f.client.request("overflow", {}), { code: "busy" });
  assert.equal(f.writes.some((m) => m.method === "overflow"), false);
  await f.client.close();
  assert.ok((await outcomes).every((x) => x.status === "rejected"));
});

for (const [name, data, code] of [
  ["malformed", Buffer.from("not json\n"), "invalid_frame"],
  ["oversized", Buffer.alloc(MAX_FRAME_BYTES + 1, 97), "frame_too_large"],
  ["unknown id", Buffer.from('{"id":999,"result":{}}\n'), "unknown_response"],
]) {
  test(`${name} response poisons the connection and no request is replayed`, async () => {
    const f = fixture();
    await f.client.start();
    const pending = f.client.request("read", {});
    const rejected = assert.rejects(pending, { code });
    f.child.stdout.emit("data", data);
    await rejected;
    await assert.rejects(f.client.start(), { code: "closed" });
    assert.equal(f.writes.filter((m) => m.method === "read").length, 1);
    await f.client.close();
  });
}

test("truncated response on process exit rejects its caller", async () => {
  const f = fixture();
  await f.client.start();
  const pending = f.client.request("read", {});
  const rejected = assert.rejects(pending, { code: "transport_closed" });
  f.child.stdout.emit("data", Buffer.from('{"id":2,"result":'));
  f.child.emit("close", 1);
  await rejected;
  await f.client.close();
});

test("timeout invalidates a session and cancellation rejects all in-flight work", async () => {
  const f = fixture({ timeoutMs: 15 });
  await f.client.start();
  await assert.rejects(f.client.request("slow", {}), { code: "timeout" });
  await f.client.close();
  const g = fixture();
  await g.client.start();
  const controller = new AbortController();
  const pending = g.client.request("read", {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "cancelled" });
  controller.abort();
  await rejected;
  await g.client.close();
});

test("RPC errors have bounded diagnostics and do not expose server data", async () => {
  const f = fixture({ reply: (message, send) => send({ id: message.id, error: { message: "secret server error" } }) });
  await f.client.start();
  await assert.rejects(f.client.request("read", {}), (error) => error.code === "rpc_error" && !error.message.includes("secret"));
  await f.client.close();
});

test("connector runtime overrides disable unrelated configured MCPs without copying secrets or writing global config", async () => {
  const f = fixture({ reply: (message, send) => send({ id: message.id, result: {
    config: { mcp_servers: { node_repl: { command: "node", env: { SECRET: "not-for-thread" } },
      "sequential-thinking": { command: "npx" }, codex_apps: { enabled: true } } },
  } }) });
  await f.client.start();
  assert.deepEqual(await f.client.connectorThreadConfig(), {
    "mcp_servers.node_repl.enabled": false,
    "mcp_servers.sequential-thinking.enabled": false,
  });
  assert.equal(f.writes.some((m) => m.method === "config/value/write"), false);
  await f.client.close();
});

test("close escalates a stuck worker and waits for the close event", async () => {
  const f = fixture({ ignoreTerm: true });
  await f.client.start();
  await f.client.close();
  assert.ok(f.kills.includes("SIGKILL"));
  assert.equal(f.client.child, null);
  assert.equal(f.lifecycle.at(-1)[0], "exit");
});
