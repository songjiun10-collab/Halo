"use strict";

// Background-runtime plan Task 5: the private transport between a UI-process
// client and the background-service process's TaskHost/ChildAgentCoordinator.
// Wire-compatible in spirit with main/approver-client.js and experiments/
// e007_dual_agent_provenance_gate/channel.py's UnixSocketChannel -- a 4-byte
// big-endian length prefix followed by a UTF-8 JSON object, capped at 65536
// bytes -- but persistent and bidirectional (many request/response
// exchanges plus server-pushed events over one long-lived connection),
// unlike the approver's one-shot-per-connection protocol.
//
// Trust boundary: a Unix domain socket under a 0700 directory already
// restricts connect() to this same OS user (or root) -- Node has no
// cross-platform, dependency-free way to read a connecting peer's real
// uid/gid off a UnixSocket (no SO_PEERCRED binding in core `net`), so this
// module does not claim to perform that syscall-level check. Instead it
// combines that filesystem-level restriction with an explicit, random
// capability token that every connection must present before its first call
// is dispatched (kept only in the service's trusted memory -- see
// background-runtime-service.js) -- for a single-user local service this is
// at least as strong a boundary as a peer-uid check would add, and it is
// disclosed here rather than silently assumed.

const net = require("net");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const MAX_FRAME_BYTES = 65536;
// A call result too large for one frame is sent as ordered chunks of the
// result's JSON text and reassembled by the caller. Each chunk is a bounded
// number of characters (worst case under 6 bytes each once escaped, so one
// chunk always fits a frame); the whole result is capped so a peer can never
// make the other side buffer without limit.
const RESULT_CHUNK_CHARS = 8192;
const MAX_RESULT_CHARS = 8 * 1024 * 1024;

class RuntimeIpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeIpcError";
    this.code = code;
  }
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new RuntimeIpcError("frame_too_large", `frame must be 1..${MAX_FRAME_BYTES} bytes, got ${body.length}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Incremental decoder: feed raw socket bytes as they arrive, get back the
// array of complete messages a chunk completed (often zero, sometimes more
// than one). Throws RuntimeIpcError on any wire-protocol violation; the
// caller is responsible for destroying the connection when it does.
class FrameDecoder {
  constructor() {
    this._buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : Buffer.from(chunk);
    const messages = [];
    for (;;) {
      if (this._buffer.length < 4) break;
      const expected = this._buffer.readUInt32BE(0);
      if (expected <= 0 || expected > MAX_FRAME_BYTES) {
        throw new RuntimeIpcError("frame_too_large", `declared frame length ${expected} exceeds ${MAX_FRAME_BYTES}`);
      }
      if (this._buffer.length < 4 + expected) break;
      const body = this._buffer.subarray(4, 4 + expected);
      this._buffer = this._buffer.subarray(4 + expected);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        throw new RuntimeIpcError("invalid_frame", "frame body is not valid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RuntimeIpcError("invalid_frame", "frame body must be a JSON object");
      }
      messages.push(parsed);
    }
    return messages;
  }
}

// Finds the deepest path prefix of `resolved` that currently exists, via
// lstat (never following a symlink at that prefix itself). Ancestors ABOVE
// that prefix are the surrounding OS/filesystem's own territory (e.g.
// macOS's /var -> /private/var, or wherever os.tmpdir() lives) -- outside
// this app's control, and never walked or rejected here, same as
// main/index.js's own makeSocketDir() accepting them via fs.realpathSync.
async function findExistingAncestor(resolved) {
  let current = resolved;
  for (;;) {
    try {
      return await fsp.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return null; // reached the filesystem root
      current = parent;
    }
  }
}

// Ensures `dirPath` exists as a real (non-symlink) directory, mode 0700,
// owned by this process's user, creating any missing components. Unlike
// main/index.js's mkdtemp-based approver socket dir (a fresh, unpredictable
// name each run), this path is fixed/predictable across service restarts,
// so a symlink pre-planted at or below it -- by another process running as
// this same user, before the service starts -- is refused rather than
// silently followed.
async function prepareSocketDir(dirPath, { socketRoot } = {}) {
  const resolved = path.resolve(dirPath);
  if (socketRoot !== undefined) {
    const root = path.resolve(socketRoot);
    const relative = path.relative(root, resolved);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new RuntimeIpcError("invalid_socket_dir", "socket directory must be beneath the private socket root");
    }
    const rootStat = await fsp.lstat(root).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (rootStat?.isSymbolicLink()) {
      throw new RuntimeIpcError("symlink_rejected", `${root} is a symlink; refusing to use it as the socket root`);
    }
    if (rootStat && !rootStat.isDirectory()) {
      throw new RuntimeIpcError("invalid_socket_dir", `${root} is not a directory`);
    }
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await fsp.lstat(current).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) {
        throw new RuntimeIpcError("symlink_rejected", `${current} is a symlink; refusing to use a socket path under it`);
      }
      if (stat && !stat.isDirectory()) {
        throw new RuntimeIpcError("invalid_socket_dir", `${current} is not a directory`);
      }
    }
  }
  const existingStat = await findExistingAncestor(resolved);
  if (existingStat && existingStat.isSymbolicLink()) {
    throw new RuntimeIpcError("symlink_rejected", `a component of ${resolved} is a symlink; refusing to use a socket path under it`);
  }
  try {
    await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fsp.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new RuntimeIpcError("symlink_rejected", `${resolved} is a symlink; refusing to use a socket path under it`);
  }
  if (!stat.isDirectory()) {
    throw new RuntimeIpcError("invalid_socket_dir", `${resolved} is not a directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new RuntimeIpcError("invalid_socket_dir", `${resolved} is not owned by the current user`);
  }
  await fsp.chmod(resolved, 0o700);
  return resolved;
}

// Removes whatever a previous, uncleanly-terminated service instance left at
// `socketPath` -- but only if it is actually a socket file, never a symlink
// (which could point anywhere) and never a plain file (which would mean
// something unexpected already occupies this path).
async function removeStaleSocket(socketPath) {
  let stat;
  try {
    stat = await fsp.lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new RuntimeIpcError("symlink_rejected", `${socketPath} is a symlink; refusing to bind through it`);
  }
  if (!stat.isSocket()) {
    throw new RuntimeIpcError("invalid_socket_path", `${socketPath} exists and is not a socket`);
  }
  // Do not unlink a live service's listening socket. In particular, two
  // Electron processes racing startup must not disconnect whichever one
  // bound this path first. Only an ECONNREFUSED result is evidence of a stale
  // socket; other probe failures fail closed.
  await new Promise((resolve, reject) => {
    const probe = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new RuntimeIpcError("socket_probe_timeout", `could not determine whether ${socketPath} is stale`));
    }, 1000);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      reject(new RuntimeIpcError("socket_in_use", `${socketPath} is accepting connections; refusing to unlink a live service socket`));
    });
    probe.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  const currentStat = await fsp.lstat(socketPath);
  if (currentStat.isSymbolicLink() || !currentStat.isSocket() || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
    throw new RuntimeIpcError("socket_changed", `${socketPath} changed while stale-socket status was being checked`);
  }
  await fsp.unlink(socketPath);
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a constant-time compare against itself so a length mismatch
    // does not short-circuit measurably faster than a same-length mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Server side: listens on a Unix domain socket, requires each connection to
// present the exact capability token before dispatching any call, and
// forwards authenticated calls to the injected `onCall(method, params,
// clientId)` -- the caller (background-runtime-service.js) owns the actual
// method allowlist; this transport has no notion of which methods exist.
class RuntimeIpcServer {
  constructor({ socketPath, socketRoot, capability, onCall, netModule } = {}) {
    if (typeof socketPath !== "string" || !socketPath) {
      throw new RuntimeIpcError("invalid_config", "socketPath is required");
    }
    if (typeof capability !== "string" || capability.length < 16) {
      throw new RuntimeIpcError("invalid_config", "capability must be a string of at least 16 characters");
    }
    if (typeof onCall !== "function") {
      throw new RuntimeIpcError("invalid_config", "onCall is required");
    }
    this._socketPath = socketPath;
    this._socketRoot = socketRoot;
    this._capability = capability;
    this._onCall = onCall;
    this._net = netModule || net;
    this._server = null;
    this._ownsSocket = false;
    this._clients = new Map(); // socket -> { authenticated, clientId, decoder }
  }

  async listen() {
    const socketDir = path.dirname(this._socketPath);
    await prepareSocketDir(socketDir, { socketRoot: this._socketRoot });
    await removeStaleSocket(this._socketPath);
    const server = this._net.createServer((socket) => this._handleConnection(socket));
    this._server = server;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(this._socketPath, () => {
          server.removeListener("error", onError);
          this._ownsSocket = true;
          resolve();
        });
      });
      await fsp.chmod(this._socketPath, 0o600);
    } catch (error) {
      if (this._server === server) this._server = null;
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      if (this._ownsSocket) {
        this._ownsSocket = false;
        await fsp.unlink(this._socketPath).catch(() => {});
      }
      throw error;
    }
  }

  _handleConnection(socket) {
    const state = { authenticated: false, clientId: null, decoder: new FrameDecoder() };
    this._clients.set(socket, state);
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = state.decoder.push(chunk);
      } catch (error) {
        this._safeWrite(socket, { type: "error", error: { code: error.code || "invalid_frame", message: error.message } });
        socket.destroy();
        return;
      }
      for (const message of messages) this._handleMessage(socket, state, message);
    });
    socket.on("error", () => {});
    socket.on("close", () => this._clients.delete(socket));
  }

  _handleMessage(socket, state, message) {
    if (!state.authenticated) {
      if (message.type !== "attach" || typeof message.capability !== "string" ||
          !timingSafeEqualStrings(message.capability, this._capability)) {
        this._safeWrite(socket, { type: "error", error: { code: "unauthorized", message: "invalid or missing capability" } });
        socket.destroy();
        return;
      }
      state.authenticated = true;
      state.clientId = typeof message.clientId === "string" ? message.clientId : null;
      this._safeWrite(socket, { type: "attached" });
      return;
    }
    if (message.type !== "call" || typeof message.id !== "string" || typeof message.method !== "string") {
      this._safeWrite(socket, { type: "error", error: { code: "invalid_message", message: "expected a call message" } });
      return;
    }
    Promise.resolve()
      .then(() => this._onCall(message.method, message.params, state.clientId))
      .then((result) => this._writeResult(socket, message.id, result === undefined ? null : result))
      .catch((error) => this._safeWrite(socket, {
        type: "error",
        id: message.id,
        error: { code: error?.code || "call_failed", message: error?.message || String(error) },
      }));
  }

  _writeResult(socket, id, result) {
    const frame = { type: "result", id, result };
    let single = null;
    try { single = encodeFrame(frame); } catch (error) { if (error.code !== "frame_too_large") throw error; }
    if (single) {
      if (!socket.destroyed) socket.write(single);
      return;
    }
    const text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS) {
      throw Object.assign(new Error(`result exceeds ${MAX_RESULT_CHARS} characters`), { code: "result_too_large" });
    }
    const total = Math.ceil(text.length / RESULT_CHUNK_CHARS);
    for (let index = 0; index < total; index += 1) {
      this._safeWrite(socket, { type: "result_chunk", id, index, last: index === total - 1, data: text.slice(index * RESULT_CHUNK_CHARS, (index + 1) * RESULT_CHUNK_CHARS) });
    }
  }

  _safeWrite(socket, message) {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(message));
    } catch {
      socket.destroy();
    }
  }

  // Pushes an unsolicited event to every currently-authenticated client
  // (e.g. taskHost.onEvent forwarding). Never buffered for a client that has
  // not yet authenticated or has disconnected.
  broadcast(event, payload) {
    for (const [socket, state] of this._clients) {
      if (state.authenticated) this._safeWrite(socket, { type: "event", event, payload });
    }
  }

  async close() {
    for (const socket of this._clients.keys()) socket.destroy();
    this._clients.clear();
    const server = this._server;
    this._server = null;
    if (server?.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (this._ownsSocket) {
      this._ownsSocket = false;
      await fsp.unlink(this._socketPath).catch(() => {});
    }
  }
}

// Client side: connects, presents the capability, and exposes a simple
// call(method, params) -> Promise<result> request/response API plus
// on(event, listener) for server-pushed events.
class RuntimeIpcClient {
  constructor({ socketPath, capability, clientId, netModule } = {}) {
    if (typeof socketPath !== "string" || !socketPath) {
      throw new RuntimeIpcError("invalid_config", "socketPath is required");
    }
    if (typeof capability !== "string" || !capability) {
      throw new RuntimeIpcError("invalid_config", "capability is required");
    }
    this._socketPath = socketPath;
    this._capability = capability;
    this._clientId = clientId || null;
    this._net = netModule || net;
    this._socket = null;
    this._decoder = new FrameDecoder();
    this._chunks = new Map(); // call id -> partially received chunked result
    this._pending = new Map(); // id -> { resolve, reject }
    this._nextId = 1;
    this._attached = false;
    this._emitter = new EventEmitter();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = this._net.createConnection({ path: this._socketPath });
      this._socket = socket;
      const onConnectError = (error) => reject(error);
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.removeListener("error", onConnectError);
        resolve();
      });
    });

    const attachResult = new Promise((resolve, reject) => {
      this._resolveAttach = resolve;
      this._rejectAttach = reject;
    });
    this._socket.on("data", (chunk) => this._onData(chunk));
    this._socket.on("close", () => this._onClose());
    this._socket.on("error", () => {});
    this._socket.write(encodeFrame({ type: "attach", capability: this._capability, clientId: this._clientId }));
    await attachResult;
    this._attached = true;
  }

  async call(method, params) {
    if (!this._attached) throw new RuntimeIpcError("not_connected", "call() requires connect() to complete first");
    const id = String(this._nextId++);
    const promise = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    this._socket.write(encodeFrame({ type: "call", id, method, params: params === undefined ? null : params }));
    return promise;
  }

  on(event, listener) {
    this._emitter.on(event, listener);
    return () => this._emitter.removeListener(event, listener);
  }

  async close() {
    this._socket?.destroy();
  }

  _onData(chunk) {
    let messages;
    try {
      messages = this._decoder.push(chunk);
    } catch (error) {
      this._failEverything(error);
      this._socket.destroy();
      return;
    }
    for (const message of messages) this._onMessage(message);
  }

  _onMessage(message) {
    if (message.type === "attached") {
      this._resolveAttach?.();
      return;
    }
    if (message.type === "event") {
      this._emitter.emit(message.event, message.payload);
      return;
    }
    if (message.type === "result_chunk" && typeof message.id === "string") {
      this._onResultChunk(message);
      return;
    }
    if (message.type === "result" || (message.type === "error" && message.id)) {
      this._chunks.delete(message.id);
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      if (message.type === "result") {
        pending.resolve(message.result);
      } else {
        pending.reject(new RuntimeIpcError(message.error?.code || "call_failed", message.error?.message || "call failed"));
      }
      return;
    }
    if (message.type === "error" && !message.id) {
      const error = new RuntimeIpcError(message.error?.code || "unauthorized", message.error?.message || "connection rejected");
      this._rejectAttach?.(error);
      this._failEverything(error);
    }
  }

  _onResultChunk(message) {
    const pending = this._pending.get(message.id);
    if (!pending) return;
    const entry = this._chunks.get(message.id) ?? { next: 0, parts: [], chars: 0 };
    const bad = message.index !== entry.next || typeof message.data !== "string" || message.data.length === 0 || message.data.length > RESULT_CHUNK_CHARS ||
      entry.chars + message.data.length > MAX_RESULT_CHARS;
    if (bad) {
      this._chunks.delete(message.id);
      this._pending.delete(message.id);
      pending.reject(new RuntimeIpcError("invalid_frame", "malformed or oversized chunked result"));
      return;
    }
    entry.parts.push(message.data);
    entry.chars += message.data.length;
    entry.next += 1;
    if (message.last !== true) {
      this._chunks.set(message.id, entry);
      return;
    }
    this._chunks.delete(message.id);
    this._pending.delete(message.id);
    try {
      pending.resolve(JSON.parse(entry.parts.join("")));
    } catch {
      pending.reject(new RuntimeIpcError("invalid_frame", "chunked result is not valid JSON"));
    }
  }

  _onClose() {
    if (!this._attached) {
      const error = new RuntimeIpcError("connection_closed", "socket closed before attach completed");
      this._rejectAttach?.(error);
    }
    this._failEverything(new RuntimeIpcError("connection_closed", "connection closed"));
  }

  _failEverything(error) {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
    this._chunks.clear();
  }
}

module.exports = {
  MAX_FRAME_BYTES,
  RuntimeIpcError,
  encodeFrame,
  FrameDecoder,
  prepareSocketDir,
  removeStaleSocket,
  RuntimeIpcServer,
  RuntimeIpcClient,
};
