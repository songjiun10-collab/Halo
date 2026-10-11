"use strict";

// Developer-only probe. Raw CDP, no Halo harness code on the measured path.
// Question: which step around Page.enable is slow, and does the order matter?
// Uses Halo's own launch flags so the numbers describe the binary Halo ships.

const { performance } = require("node:perf_hooks");
const { acquireCdpBrowser, LEAN_FLAGS } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport } = require("../main/harness/cdp-web-contents");

interface Row { step: string; ms: number }

async function scenario(name: string, fn: (send: (m: string, p?: any, s?: string) => Promise<any>) => Promise<Row[]>) {
  const browser = await acquireCdpBrowser({});
  try {
    const transport = await connectCdpTransport(browser.wsUrl);
    const rows = await fn((m, p, s) => transport.send(m, p, s));
    process.stdout.write(`${JSON.stringify({ scenario: name, rows: rows.map((r) => ({ step: r.step, ms: Number(r.ms.toFixed(1)) })) })}\n`);
    // Close the transport before the browser, or failAll()'s rejection lands
    // as an unhandled rejection after browser.close() tore the socket down.
    transport.close();
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  } finally {
    await browser.close();
  }
}

const timed = async (rows: Row[], label: string, fn: () => Promise<any>) => {
  const start = performance.now();
  const out = await fn();
  rows.push({ step: label, ms: performance.now() - start });
  return out;
};

async function main() {
  // Scenario A: Halo's exact order -- 14 Browser.setPermission, then Fetch.enable, then Page.enable.
  await scenario("halo-order", async (send) => {
    const rows: Row[] = [];
    const ctx = await timed(rows, "Target.createBrowserContext", () => send("Target.createBrowserContext"));
    const scope = { browserContextId: ctx.browserContextId };
    await timed(rows, "Target.setDiscoverTargets", () => send("Target.setDiscoverTargets", { discover: true }));
    const { targetId } = await timed(rows, "Target.createTarget", () => send("Target.createTarget", { url: "about:blank", ...scope }));
    const { sessionId } = await timed(rows, "Target.attachToTarget", () => send("Target.attachToTarget", { targetId, flatten: true }));
    await timed(rows, "Browser.setDownloadBehavior", () => send("Browser.setDownloadBehavior", { behavior: "deny", ...scope }));
    await timed(rows, "14x Browser.setPermission", () => Promise.all([
      "geolocation", "notifications", "camera", "microphone", "midi", "clipboard-read", "clipboard-write",
      "screen-wake-lock", "persistent-storage", "background-sync", "idle-detection", "window-management", "local-fonts", "display-capture",
    ].map((name) => send("Browser.setPermission", { permission: { name }, setting: "denied", ...scope }))));
    await timed(rows, "Fetch.enable", () => send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId));
    await timed(rows, "Page.enable", () => send("Page.enable", {}, sessionId));
    await timed(rows, "Network.enable", () => send("Network.enable", {}, sessionId));
    await timed(rows, "Runtime.enable", () => send("Runtime.enable", {}, sessionId));
    await timed(rows, "Page.getFrameTree", () => send("Page.getFrameTree", {}, sessionId));
    await timed(rows, "Page.getNavigationHistory", () => send("Page.getNavigationHistory", {}, sessionId));
    await timed(rows, "close", async () => { send("Target.closeTarget", { targetId }); send("Target.disposeBrowserContext", { browserContextId: ctx.browserContextId }); });
    return rows;
  });

  // Scenario B: Page.enable FIRST, before any Browser.* / Fetch.enable work.
  await scenario("page-enable-first", async (send) => {
    const rows: Row[] = [];
    const ctx = await timed(rows, "Target.createBrowserContext", () => send("Target.createBrowserContext"));
    const scope = { browserContextId: ctx.browserContextId };
    await timed(rows, "Target.setDiscoverTargets", () => send("Target.setDiscoverTargets", { discover: true }));
    const { targetId } = await timed(rows, "Target.createTarget", () => send("Target.createTarget", { url: "about:blank", ...scope }));
    const { sessionId } = await timed(rows, "Target.attachToTarget", () => send("Target.attachToTarget", { targetId, flatten: true }));
    await timed(rows, "Page.enable", () => send("Page.enable", {}, sessionId));
    await timed(rows, "Browser.setDownloadBehavior", () => send("Browser.setDownloadBehavior", { behavior: "deny", ...scope }));
    await timed(rows, "Fetch.enable", () => send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId));
    await timed(rows, "Network+Runtime.enable", () => Promise.all([send("Network.enable", {}, sessionId), send("Runtime.enable", {}, sessionId)]));
    await timed(rows, "close", async () => { send("Target.closeTarget", { targetId }); send("Target.disposeBrowserContext", { browserContextId: ctx.browserContextId }); });
    return rows;
  });

  process.stdout.write(JSON.stringify({ note: `leanFlags=${LEAN_FLAGS.length}`, limits: ["Raw CDP probe against Halo's own headless_shell; excludes Halo harness and model time."] }) + "\n");
}

void main().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });