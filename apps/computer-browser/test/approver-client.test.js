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
const os = require("node:os");
const path = require("node:path");
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
