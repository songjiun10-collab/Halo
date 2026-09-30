"use strict";

// Deterministic before/after comparison of navigate()'s readiness mode
// ("load", the default, vs "dom-ready") on the SAME simulated page-load
// shape, using a fake WebContentsView -- no real Electron, no real network,
// no real page. This demonstrates the mechanism's effect under controlled,
// repeatable conditions; it is NOT a measurement of any real page's actual
// load timing, and the default stays "load" until real measured pages
// justify switching it (see main/control-api.js's _loadWithTimeout()
// comment and the design doc's "정직한 한계").
//
// Usage: node bench/navigation-readiness-bench.js

const { ControlApi } = require("../main/control-api");

function makeFakeView({ domReadyAtMs, fullLoadAtMs }) {
  return {
    webContents: {
      loadURL: () => new Promise((resolve) => setTimeout(resolve, fullLoadAtMs)),
      stop: () => {},
      once: (event, cb) => {
        if (event === "dom-ready") setTimeout(cb, domReadyAtMs);
      },
      on: () => {},
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async () => null,
    },
    setVisible: () => {},
    setBounds: () => {},
  };
}

async function measure(navigationWaitUntil, shape, iterations) {
  const api = new ControlApi({
    window: {},
    socketPath: "/tmp/bench.sock",
    navigationWaitUntil,
    navigationTimeoutMs: 30000,
  });
  for (let i = 0; i < iterations; i++) {
    api._view = makeFakeView(shape);
    await api.navigate("https://example.com");
  }
  return api.getMetricsSummary().navigation;
}

async function main() {
  const iterations = Number(process.argv[2]) || 30;
  // A simulated page whose HTML finishes parsing (dom-ready) well before its
  // subresources finish loading (full "load") -- a common real-world shape
  // for pages with images/analytics/ads, NOT a measured value from any real
  // site.
  const shape = { domReadyAtMs: 50, fullLoadAtMs: 400 };

  const loadStats = await measure("load", shape, iterations);
  const domReadyStats = await measure("dom-ready", shape, iterations);

  console.log(
    `\nNavigation readiness comparison over ${iterations} iterations ` +
      `(SIMULATED page: dom-ready at ${shape.domReadyAtMs}ms, full load at ${shape.fullLoadAtMs}ms):\n`,
  );
  console.log(`  waitUntil="load"      p50=${loadStats.p50}ms  p95=${loadStats.p95}ms  outcomes=${JSON.stringify(loadStats.outcomes)}`);
  console.log(`  waitUntil="dom-ready" p50=${domReadyStats.p50}ms  p95=${domReadyStats.p95}ms  outcomes=${JSON.stringify(domReadyStats.outcomes)}`);
  console.log(
    `\nUnder this simulated shape, "dom-ready" would save ~${loadStats.p50 - domReadyStats.p50}ms per navigation.\n` +
      "This is a controlled comparison on a made-up load shape, not evidence about any real page.\n",
  );
}

main();
