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

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME) {
    throw new RangeError("JSON frame must be 1..65536 bytes");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function requestDecision(socketPath, request) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryConnect = () => {
      const socket = net.createConnection({ path: socketPath });
      let settled = false;
      let buffer = Buffer.alloc(0);
      let expected = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
        fn(value);
      };

      const timeout = setTimeout(() => finish(reject, new Error("approver request timed out")), REQUEST_TIMEOUT_MS);

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
            finish(resolve, payload);
          } catch (error) {
            finish(reject, error);
          }
        }
      });

      socket.on("error", (error) => {
        if (settled) return;
        if (error.code === "ENOENT" && attempt < RETRY_DELAYS_MS.length) {
          clearTimeout(timeout);
          const delay = RETRY_DELAYS_MS[attempt++];
          socket.removeAllListeners();
          socket.destroy();
          setTimeout(tryConnect, delay);
          return;
        }
        finish(reject, error);
      });
    };

    tryConnect();
  });
}

module.exports = { requestDecision, encodeFrame, MAX_FRAME };
