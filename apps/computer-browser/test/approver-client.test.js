"use strict";

// Tests for main/approver-client.js against a real Unix domain socket (a
// fake in-process "approver" server speaking the exact same length-prefixed
// JSON wire framing as approver/approver_service.py), so these exercise the
// real net.createConnection() path -- not a mocked requestDecision.
//
// Task 4 hardening under test: the approver's response was previously
// trusted as-is once it parsed as JSON, with no check that `decision` is one
// of the known enum values or that `reasons` is an array. A malformed/buggy
// approver response (e.g. `{}`, or a typo'd decision string) would resolve
// successfully with a shape the callers don't actually handle correctly
// (see main/control-api.js's _applyDecision, whose final "else" branch
// happily returns `undefined` for an unrecognized decision instead of a
// real value) -- effectively an implicit, unintended "deny" that isn't
// reported as either an error or a deny. requestDecision must fail closed
// (reject) instead of passing a malformed response through as if it were
// legitimate.

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { requestDecision } = require("../main/approver-client");

async function mkSocketPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-approver-client-"));
  return path.join(dir, "approver.sock");
}

function encode(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

// respond(request) -> a response payload to send back, or a Buffer to send
// raw bytes (for malformed-frame tests), or null to hang up with no reply.
function startFakeApprover(socketPath, respond) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let expected = null;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (expected === null && buffer.length >= 4) {
          expected = buffer.readUInt32BE(0);
        }
        if (expected !== null && buffer.length >= 4 + expected) {
          const request = JSON.parse(buffer.subarray(4, 4 + expected).toString("utf8"));
          const out = respond(request);
          if (out === undefined) return; // never reply -- simulates a hang, for abort/timeout tests
          if (out === null) {
            socket.end();
            return;
          }
          const frame = Buffer.isBuffer(out) ? out : encode(out);
          socket.end(frame);
        }
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

// Reproduces the real ECONNREFUSED race found in production (2026-09-27
// follow-up): approver_service.py's UnixSocketChannel.listen() is a
// one-shot channel reused sequentially in a `while True` loop -- it
// closes its listening socket and unlinks the path immediately after
// accept() returns (before the request is even processed), then rebinds on
// the next loop iteration. A connect() attempt landing in the narrow window
// where the path exists but nothing is bound-and-listening on it yet (or
// the previous listener already closed) fails with ECONNREFUSED, not
// ENOENT -- a real Electron end-to-end run hit this after ~234 rapid
// approve() round-trips. This helper produces a REAL ECONNREFUSED the same
// way: bind a real process on the socket path, kill it without letting it
// clean up, so the path is left behind as an orphaned/dead socket file that
// nothing is listening on.
function leaveStaleSocketFile(socketPath) {
  return new Promise((resolve, reject) => {
    const script = [
      'const net = require("node:net");',
      "const server = net.createServer();",
      'server.listen(process.argv[1], () => process.stdout.write("READY\\n"));',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, "--", socketPath], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("READY")) {
        child.kill("SIGKILL");
        child.on("exit", () => resolve());
      }
    });
  });
}

test("requestDecision retries past a real transient ECONNREFUSED (dead/orphaned socket file) the same way it already retries ENOENT", async () => {
  const socketPath = await mkSocketPath();
  await leaveStaleSocketFile(socketPath);
  assert.ok(fsSync.existsSync(socketPath), "the stale socket file must actually be left behind for this test to be real");

  let server = null;
  // Simulate the approver's own loop catching back up: unlink the dead
  // file and start a real listener on the same path shortly after --
  // exactly what a live approver process does on its next iteration.
  const recovery = (async () => {
    await new Promise((r) => setTimeout(r, 15));
    await fs.unlink(socketPath).catch(() => {});
    server = await startFakeApprover(socketPath, () => ({ decision: "allow", reasons: [] }));
  })();

  // Promise.allSettled (not a bare `await pending` racing a detached
  // setTimeout) so that even when requestDecision rejects immediately
  // (pre-fix, no ECONNREFUSED retry), this test still waits for `recovery`
  // to finish starting its server before returning -- otherwise that server
  // would be created *after* the test function already returned, with
  // nothing left to close it, leaking an open handle that hangs the whole
  // `node --test` process on exit.
  const [decisionResult] = await Promise.allSettled([requestDecision(socketPath, { action: "navigate" }), recovery]);
  try {
    if (decisionResult.status === "rejected") throw decisionResult.reason;
    assert.equal(decisionResult.value.decision, "allow");
  } finally {
    if (server) server.close();
  }
});

test("requestDecision still fails closed (rejects) if ECONNREFUSED persists past the whole retry budget -- this is not an unbounded/broad retry", async () => {
  const socketPath = await mkSocketPath();
  await leaveStaleSocketFile(socketPath);
  // Nothing ever listens again on this path -- a genuinely dead approver,
  // not a transient rebind race. requestDecision must not hang or silently
  // treat this as success.
  await assert.rejects(() => requestDecision(socketPath, { action: "navigate" }), /ECONNREFUSED|ENOENT/);
});

test("requestDecision resolves a well-formed allow response", async () => {
  const socketPath = await mkSocketPath();
  const server = await startFakeApprover(socketPath, () => ({ decision: "allow", reasons: [] }));
  try {
    const result = await requestDecision(socketPath, { action: "navigate" });
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.reasons, []);
  } finally {
    server.close();
  }
});

for (const decision of ["allow", "review", "deny", "quarantine"]) {
  test(`requestDecision resolves a well-formed ${decision} response`, async () => {
    const socketPath = await mkSocketPath();
    const server = await startFakeApprover(socketPath, () => ({ decision, reasons: ["because"] }));
    try {
      const result = await requestDecision(socketPath, { action: "navigate" });
      assert.equal(result.decision, decision);
    } finally {
      server.close();
    }
  });
}

test("requestDecision rejects a response with an unknown decision value instead of passing it through", async () => {
  const socketPath = await mkSocketPath();
  const server = await startFakeApprover(socketPath, () => ({ decision: "maybe", reasons: [] }));
  try {
    await assert.rejects(() => requestDecision(socketPath, { action: "navigate" }), /decision/i);
  } finally {
    server.close();
  }
});

test("requestDecision rejects a response missing the decision field entirely", async () => {
  const socketPath = await mkSocketPath();
  const server = await startFakeApprover(socketPath, () => ({ reasons: ["oops, forgot decision"] }));
  try {
    await assert.rejects(() => requestDecision(socketPath, { action: "navigate" }));
  } finally {
    server.close();
  }
});

test("requestDecision rejects a response whose reasons field is not an array", async () => {
  const socketPath = await mkSocketPath();
  const server = await startFakeApprover(socketPath, () => ({ decision: "deny", reasons: "not an array" }));
  try {
    await assert.rejects(() => requestDecision(socketPath, { action: "navigate" }), /reasons/i);
  } finally {
    server.close();
  }
});

test("requestDecision rejects a non-object response (e.g. a bare JSON array)", async () => {
  const socketPath = await mkSocketPath();
  const server = await startFakeApprover(socketPath, () => [1, 2, 3]);
  try {
    await assert.rejects(() => requestDecision(socketPath, { action: "navigate" }));
  } finally {
    server.close();
  }
});

// --- Abort: cancels the in-flight request instead of waiting out the full
// 5s timeout.

test("requestDecision aborts immediately when the given AbortSignal fires, without waiting for the timeout", async () => {
  const socketPath = await mkSocketPath();
  // Never actually reply -- this server just holds the connection open.
  const server = await startFakeApprover(socketPath, () => undefined);
  try {
    const controller = new AbortController();
    const pending = requestDecision(socketPath, { action: "navigate" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    const start = Date.now();
    await assert.rejects(() => pending, /abort/i);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `expected the abort to short-circuit well before the 5s timeout, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test("requestDecision resolves normally when the signal never fires", async () => {
  const socketPath = await mkSocketPath();
  const server = await startFakeApprover(socketPath, () => ({ decision: "allow", reasons: [] }));
  try {
    const controller = new AbortController();
    const result = await requestDecision(socketPath, { action: "navigate" }, { signal: controller.signal });
    assert.equal(result.decision, "allow");
  } finally {
    server.close();
  }
});
