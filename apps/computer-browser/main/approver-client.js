"use strict";

const net = require("net");

// Wire-compatible with experiments/e007_dual_agent_provenance_gate/channel.py's
// UnixSocketChannel: 4-byte big-endian length prefix + UTF-8 JSON body, one
// request/response exchange per connection, max 65536 bytes.
const MAX_FRAME = 65536;
const REQUEST_TIMEOUT_MS = 5000;
// The approver's UnixSocketChannel.listen() unlinks its socket path after
// every exchange and only recreates it on the next loop iteration, so a
// connect() attempt can legitimately race an ENOENT for a few milliseconds.
// This is a known, documented property of reusing a one-shot channel as a
// standing service (see the design doc) -- not a bug to paper over silently.
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400];
const VALID_DECISIONS = new Set(["allow", "review", "deny", "quarantine"]);

class ApproverProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApproverProtocolError";
  }
}

// The approver's response must never be trusted as-is just because it
// parsed as JSON -- a malformed/buggy response (missing decision, an
// unrecognized decision string, a non-array reasons field, or a non-object
// entirely) used to be resolved unchanged. control-api.js's _applyDecision
// only branches on decision === "allow"/"review" and otherwise falls into
// its deny path -- with a malformed response that final branch would return
// `undefined` instead of a real outcome string, which callers like
// startTask()'s step chain treat as "not allow" and silently mark the task
// completed. Failing closed here (reject instead of resolve) turns that
// into a real, catchable error instead of a silent wrong-outcome bug.
function validateDecisionResponse(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApproverProtocolError("approver response must be a JSON object");
  }
  if (typeof payload.decision !== "string" || !VALID_DECISIONS.has(payload.decision)) {
    throw new ApproverProtocolError(`approver response has an invalid decision: ${JSON.stringify(payload.decision)}`);
  }
  if (payload.reasons !== undefined && !Array.isArray(payload.reasons)) {
    throw new ApproverProtocolError("approver response's reasons field must be an array");
  }
  return payload;
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME) {
    throw new RangeError("JSON frame must be 1..65536 bytes");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function requestDecision(socketPath, request, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("approver request aborted"));
      return;
    }
    let attempt = 0;
    let settled = false;
    let pendingRetryTimer = null;
    let currentSocket = null;
    let currentTimeout = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (currentTimeout) clearTimeout(currentTimeout);
      if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (currentSocket) {
        currentSocket.removeAllListeners();
        currentSocket.destroy();
      }
      fn(value);
    };

    const onAbort = () => finish(reject, new Error("approver request aborted"));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const tryConnect = () => {
      const socket = net.createConnection({ path: socketPath });
      currentSocket = socket;
      let buffer = Buffer.alloc(0);
      let expected = null;

      currentTimeout = setTimeout(() => finish(reject, new Error("approver request timed out")), REQUEST_TIMEOUT_MS);

      socket.once("connect", () => {
        try {
          socket.write(encodeFrame(request));
        } catch (error) {
          finish(reject, error);
        }
      });

      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (expected === null && buffer.length >= 4) {
          expected = buffer.readUInt32BE(0);
          if (expected <= 0 || expected > MAX_FRAME) {
            finish(reject, new Error("invalid response frame length"));
            return;
          }
        }
        if (expected !== null && buffer.length >= 4 + expected) {
          try {
            const payload = JSON.parse(buffer.subarray(4, 4 + expected).toString("utf8"));
            finish(resolve, validateDecisionResponse(payload));
          } catch (error) {
            finish(reject, error);
          }
        }
      });

      socket.on("error", (error) => {
        if (settled) return;
        if (error.code === "ENOENT" && attempt < RETRY_DELAYS_MS.length) {
          clearTimeout(currentTimeout);
          const delay = RETRY_DELAYS_MS[attempt++];
          socket.removeAllListeners();
          socket.destroy();
          pendingRetryTimer = setTimeout(tryConnect, delay);
          return;
        }
        finish(reject, error);
      });
    };

    tryConnect();
  });
}

module.exports = { requestDecision, encodeFrame, MAX_FRAME, ApproverProtocolError };
