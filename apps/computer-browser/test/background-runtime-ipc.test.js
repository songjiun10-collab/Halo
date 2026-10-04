"use strict";

// Background-runtime plan Task 5, step 1-2: failing tests for the private
// transport background-runtime-service.js/background-runtime-client.js will
// share -- a persistent Unix-domain-socket connection carrying 4-byte
// big-endian length-prefixed JSON frames (wire-compatible in spirit with
// main/approver-client.js and experiments/e007_dual_agent_provenance_gate/
// channel.py's UnixSocketChannel), capped at 65536 bytes, requiring a
// capability token on every connection before any call is dispatched, with
// no symlink-following socket directory/path setup.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  MAX_FRAME_BYTES,
  RuntimeIpcError,
  encodeFrame,
  FrameDecoder,
  prepareSocketDir,
  removeStaleSocket,
  RuntimeIpcServer,
  RuntimeIpcClient,
} = require("../main/harness/background-runtime-ipc");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-runtime-ipc-"));
}

function capability() {
  return crypto.randomBytes(32).toString("hex");
}

// ---- framing ----

test("encodeFrame/FrameDecoder round-trips a single JSON object message", () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ type: "call", id: "1", method: "ping", params: { n: 1 } });
  const messages = decoder.push(frame);
  assert.deepEqual(messages, [{ type: "call", id: "1", method: "ping", params: { n: 1 } }]);
});

test("FrameDecoder reassembles a frame split across multiple chunks", () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ type: "event", event: "x", payload: { big: "y".repeat(500) } });
  const mid = Math.floor(frame.length / 2);
  assert.deepEqual(decoder.push(frame.subarray(0, mid)), []);
  const messages = decoder.push(frame.subarray(mid));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "x");
});

test("FrameDecoder parses multiple frames delivered in one chunk", () => {
  const decoder = new FrameDecoder();
  const combined = Buffer.concat([encodeFrame({ type: "a" }), encodeFrame({ type: "b" }), encodeFrame({ type: "c" })]);
  const messages = decoder.push(combined);
  assert.deepEqual(messages.map((m) => m.type), ["a", "b", "c"]);
});

test("encodeFrame rejects a message whose JSON encoding exceeds MAX_FRAME_BYTES", () => {
  assert.throws(() => encodeFrame({ big: "x".repeat(MAX_FRAME_BYTES) }), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "frame_too_large");
    return true;
  });
});

test("FrameDecoder rejects a declared frame length exceeding MAX_FRAME_BYTES before it ever sees the body", () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => decoder.push(header), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "frame_too_large");
    return true;
  });
});

test("FrameDecoder rejects a frame body that is not valid JSON", () => {
  const decoder = new FrameDecoder();
  const body = Buffer.from("not json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  assert.throws(() => decoder.push(Buffer.concat([header, body])), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "invalid_frame");
    return true;
  });
});

function rawFrameFor(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

test("FrameDecoder rejects a JSON frame body that is not a plain object (array/string/number/null)", () => {
  for (const value of [[1, 2, 3], "hello", 42, null]) {
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(rawFrameFor(value)), (error) => {
      assert.ok(error instanceof RuntimeIpcError);
      assert.equal(error.code, "invalid_frame");
      return true;
    });
  }
});

// ---- socket directory / path hardening ----

test("prepareSocketDir creates a missing directory at mode 0700 owned by the current process", async () => {
  const root = await mkTempRoot();
  const target = path.join(root, "nested", "sockdir");
  const resolved = await prepareSocketDir(target);
  const stat = await fs.stat(resolved);
  assert.ok(stat.isDirectory());
  assert.equal(stat.mode & 0o777, 0o700);
});

test("prepareSocketDir refuses a socket directory reached through a symlinked path component", async () => {
  const root = await mkTempRoot();
  const real = path.join(root, "real");
  await fs.mkdir(real, { mode: 0o700 });
  const link = path.join(root, "link");
  await fs.symlink(real, link);
  await assert.rejects(() => prepareSocketDir(path.join(link, "sockdir")), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "symlink_rejected");
    return true;
  });
});

test("prepareSocketDir rejects an existing nested directory reached through a symlink below the trusted root", async () => {
  const root = await mkTempRoot();
  const real = path.join(root, "real", "already-exists");
  await fs.mkdir(real, { recursive: true, mode: 0o700 });
  const link = path.join(root, "alias");
  await fs.symlink(path.join(root, "real"), link);
  await assert.rejects(
    () => prepareSocketDir(path.join(link, "already-exists"), { socketRoot: root }),
    (error) => error instanceof RuntimeIpcError && error.code === "symlink_rejected",
  );
});

test("removeStaleSocket is a no-op when nothing exists at the path", async () => {
  const root = await mkTempRoot();
  await removeStaleSocket(path.join(root, "does-not-exist.sock"));
});

test("removeStaleSocket refuses to unlink a symlink at the socket path", async () => {
  const root = await mkTempRoot();
  const decoy = path.join(root, "decoy");
  await fs.writeFile(decoy, "x");
  const link = path.join(root, "socket.sock");
  await fs.symlink(decoy, link);
  await assert.rejects(() => removeStaleSocket(link), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "symlink_rejected");
    return true;
  });
  assert.equal(await fs.readFile(decoy, "utf8"), "x");
});

test("removeStaleSocket refuses to unlink a regular file masquerading at the socket path", async () => {
  const root = await mkTempRoot();
  const fakeSocket = path.join(root, "socket.sock");
  await fs.writeFile(fakeSocket, "not a socket");
  await assert.rejects(() => removeStaleSocket(fakeSocket), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "invalid_socket_path");
    return true;
  });
});

test("removeStaleSocket refuses to unlink a live listening socket", async () => {
  const root = await mkTempRoot();
  const socketPath = path.join(root, "live.sock");
  const server = new RuntimeIpcServer({ socketPath, capability: capability(), onCall: async () => null });
  await server.listen();
  await assert.rejects(() => removeStaleSocket(socketPath), (error) => {
    assert.ok(error instanceof RuntimeIpcError);
    assert.equal(error.code, "socket_in_use");
    return true;
  });
  assert.ok((await fs.lstat(socketPath)).isSocket());
  await server.close();
});

// ---- server/client end-to-end over a real Unix domain socket ----

async function makeServerAndCapability(onCall) {
  const root = await mkTempRoot();
  const socketPath = path.join(root, "runtime.sock");
  const cap = capability();
  const server = new RuntimeIpcServer({ socketPath, capability: cap, onCall: onCall || (async () => null) });
  await server.listen();
  const stat = await fs.stat(socketPath);
  assert.equal(stat.mode & 0o777, 0o600, "socket file must be 0600");
  return { server, socketPath, capability: cap, root };
}

test("a client with the correct capability attaches and a call() round-trips through onCall", async () => {
  const calls = [];
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async (method, params, clientId) => {
    calls.push({ method, params, clientId });
    return { echoed: params };
  });
  const client = new RuntimeIpcClient({ socketPath, capability: cap, clientId: "ui-1" });
  await client.connect();
  const result = await client.call("ping", { n: 42 });
  assert.deepEqual(result, { echoed: { n: 42 } });
  assert.deepEqual(calls, [{ method: "ping", params: { n: 42 }, clientId: "ui-1" }]);
  await client.close();
  await server.close();
});

test("a client presenting the wrong capability is rejected and disconnected before any call is dispatched", async () => {
  let called = false;
  const { server, socketPath } = await makeServerAndCapability(async () => { called = true; return null; });
  const client = new RuntimeIpcClient({ socketPath, capability: "wrong-capability-value-0000000000" });
  await assert.rejects(() => client.connect());
  assert.equal(called, false);
  await server.close();
});

test("an onCall rejection surfaces to the caller as a rejected call() with the same error code", async () => {
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async () => {
    const error = new Error("no such task");
    error.code = "not_active";
    throw error;
  });
  const client = new RuntimeIpcClient({ socketPath, capability: cap });
  await client.connect();
  await assert.rejects(() => client.call("stopTask", { taskId: "x" }), (error) => {
    assert.equal(error.code, "not_active");
    return true;
  });
  await client.close();
  await server.close();
});

test("concurrent calls resolve independently and out of order by their own id, never cross-delivering results", async () => {
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async (method, params) => {
    if (params.slow) await new Promise((resolve) => setTimeout(resolve, 30));
    return { method, echoedId: params.id };
  });
  const client = new RuntimeIpcClient({ socketPath, capability: cap });
  await client.connect();
  const slow = client.call("a", { slow: true, id: "slow" });
  const fast = client.call("b", { slow: false, id: "fast" });
  const [fastResult, slowResult] = await Promise.all([fast, slow]);
  assert.equal(fastResult.echoedId, "fast");
  assert.equal(slowResult.echoedId, "slow");
  await client.close();
  await server.close();
});

test("broadcast() delivers a server-pushed event only to attached clients, as an 'event' message", async () => {
  const { server, socketPath, capability: cap } = await makeServerAndCapability();
  const client = new RuntimeIpcClient({ socketPath, capability: cap });
  await client.connect();
  const received = [];
  client.on("taskEvent", (payload) => received.push(payload));
  server.broadcast("taskEvent", { taskId: "t1", state: "running" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(received, [{ taskId: "t1", state: "running" }]);
  await client.close();
  await server.close();
});

test("a client sending an oversized frame is disconnected without crashing the server or affecting other clients", async () => {
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async () => ({ ok: true }));
  const misbehaving = new RuntimeIpcClient({ socketPath, capability: cap });
  await misbehaving.connect();
  // Write a raw declared-oversized header directly at the socket level,
  // bypassing the well-behaved client's own encodeFrame() guard.
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 10, 0);
  misbehaving._socket.write(header);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const wellBehaved = new RuntimeIpcClient({ socketPath, capability: cap });
  await wellBehaved.connect();
  const result = await wellBehaved.call("ping", {});
  assert.deepEqual(result, { ok: true });
  await wellBehaved.close();
  await server.close();
});

test("server close() destroys attached client sockets and removes the socket file", async () => {
  const { server, socketPath, capability: cap } = await makeServerAndCapability();
  const client = new RuntimeIpcClient({ socketPath, capability: cap });
  await client.connect();
  await server.close();
  await assert.rejects(fs.stat(socketPath), (error) => error.code === "ENOENT");
});

test("a result larger than one frame is chunked and reassembled intact, with other calls unaffected", async () => {
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ i, text: `é${"x".repeat(500)}\n☃`.repeat(2) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > MAX_FRAME_BYTES * 4);
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async (method) => (method === "big" ? big : { ok: method }));
  const client = new RuntimeIpcClient({ socketPath, capability: cap, clientId: "ui-1" });
  await client.connect();
  const [a, b, c] = await Promise.all([client.call("big"), client.call("small"), client.call("big")]);
  assert.deepEqual(a, big);
  assert.deepEqual(c, big);
  assert.deepEqual(b, { ok: "small" });
  assert.deepEqual(await client.call("small"), { ok: "small" }, "the connection stays usable");
  await client.close();
  await server.close();
});

test("a result beyond the overall cap is a rejected call, not a dropped connection", async () => {
  const huge = { text: "y".repeat(9 * 1024 * 1024) };
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async (method) => (method === "huge" ? huge : { ok: true }));
  const client = new RuntimeIpcClient({ socketPath, capability: cap, clientId: "ui-1" });
  await client.connect();
  await assert.rejects(client.call("huge"), (e) => e.code === "result_too_large");
  assert.deepEqual(await client.call("small"), { ok: true });
  await client.close();
  await server.close();
});

test("a client rejects a malformed chunk sequence for that call only", async () => {
  const { server, socketPath, capability: cap } = await makeServerAndCapability(async () => ({ ok: true }));
  const client = new RuntimeIpcClient({ socketPath, capability: cap, clientId: "ui-1" });
  await client.connect();
  const pending = client.call("x");
  // Inject an out-of-order chunk for the in-flight id as if a faulty peer sent it.
  const id = [...client._pending.keys()][0];
  client._onMessage({ type: "result_chunk", id, index: 5, last: true, data: "{}" });
  await assert.rejects(pending, (e) => e.code === "invalid_frame");
  assert.deepEqual(await client.call("y"), { ok: true });
  await client.close();
  await server.close();
});
