"use strict";

// Deterministic local 100-page chain for real-Electron long-horizon comparison.
// No remote content, accounts, or credentials are involved.

const http = require("node:http");

function startLongHorizon100Site({ steps = 100 } = {}) {
  if (!Number.isInteger(steps) || steps < 2 || steps > 1000) {
    throw new TypeError("steps must be an integer from 2 to 1000");
  }
  const requestLog = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const match = /^\/step\/(\d+)$/.exec(url.pathname);
    const index = match ? Number(match[1]) : -1;
    requestLog.push({ method: req.method, path: url.pathname, at: Date.now() });
    if (index < 0 || index >= steps) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const last = index === steps - 1;
    const body = last
      ? `<!doctype html><meta charset="utf-8"><h1>Step ${index + 1} of ${steps}</h1><p>CHAIN-DONE-${steps}</p>`
      : `<!doctype html><meta charset="utf-8"><h1>Step ${index + 1} of ${steps}</h1><p>Progress ${index + 1}</p><a href="/step/${index + 1}">Next</a>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        steps,
        url: `http://127.0.0.1:${port}/step/0`,
        requestLog,
        stop: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

module.exports = { startLongHorizon100Site };

