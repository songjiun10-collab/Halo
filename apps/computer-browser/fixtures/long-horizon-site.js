"use strict";

// A tiny local 3-page HTTP fixture for the real-Electron long-horizon
// integration test (integration/long-horizon-electron.js). Lives OUTSIDE
// test/ for the same reason fixtures/scripted-planner.js does: node --test's
// default file discovery treats anything under a test/tests directory as a
// test to run, and while this module itself doesn't block at require time
// (startServer() must be called explicitly -- requiring it alone starts
// nothing), keeping every long-running/server fixture in one place avoids
// re-litigating that hazard per file.
//
// page1 (/) -> anchor "Next" -> page2 (/page2) -> anchor "Next" -> page3
// (/page3), which has no further links and a distinctive completion marker
// text ("DONE-XYZ") a scripted planner can pattern-match on to know the
// journey is over. Every request is logged (method, path, time) so the
// integration test can assert NO duplicate navigation happened across a
// simulated context reset / controller restart.

const http = require("node:http");

const PAGES = {
  "/": `<!doctype html><html><body><h1>Welcome</h1><p>Start of the long-horizon fixture journey.</p><a href="/page2">Next</a></body></html>`,
  "/page2": `<!doctype html><html><body><h1>Second page</h1><p>Still going.</p><a href="/page3">Next</a></body></html>`,
  "/page3": `<!doctype html><html><body><h1>Final page</h1><p>Task complete marker: DONE-XYZ</p></body></html>`,
};

function startFixtureServer() {
  const requestLog = [];
  const server = http.createServer((req, res) => {
    requestLog.push({ method: req.method, path: req.url, at: Date.now() });
    const body = PAGES[req.url];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // Port 0 -- let the OS pick a free local port; the test only ever talks
    // to itself, so there's no reason to claim a fixed port.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        requestLog,
        stop: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

module.exports = { startFixtureServer, PAGES };
