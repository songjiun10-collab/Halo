"use strict";

// End-to-end payment check on the Chromium engine (CDP), no Electron: a fake
// shop, a real Chromium page, the real BrowserAdapter and TaskController. The
// planner is scripted (observe, then press "Place order"); what is under test is
// the host's payment decision and that the shop's POST /pay happens only when it
// should. Mandates are https-only, so the shop is a local TLS server; give it a
// self-signed cert (HALO_E2E_KEY/HALO_E2E_CERT) and start Chromium with
// --ignore-certificate-errors (e.g. through a wrapper script).
// Run: HALO_CHROMIUM=/path/to/chrome HALO_E2E_KEY=key.pem HALO_E2E_CERT=cert.pem node integration/payment-chromium-e2e.js

const https = require("node:https");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CdpEngine } = require("../main/harness/cdp-engine");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const CHROMIUM = process.env.HALO_CHROMIUM;
const AGENT = "persist:halo-agent-123e4567-e89b-12d3-a456-426614174000";

async function shop(total) {
  const posts = [];
  const server = https.createServer({ key: fsSync.readFileSync(process.env.HALO_E2E_KEY), cert: fsSync.readFileSync(process.env.HALO_E2E_CERT) }, (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.method === "POST" && req.url === "/pay") {
      posts.push(req.url);
      res.end("<!doctype html><title>paid</title><p>Thank you, order placed</p>");
      return;
    }
    res.end(`<!doctype html><title>Checkout</title><p>Item $10.00</p><p>Shipping $2.50</p><p>Total ${total}</p>
      <form method="post" action="/pay"><button type="submit">Place order</button></form>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, posts, port: server.address().port };
}

async function scenario(name, { request, total, expectPosts, expectPause }) {
  const s = await shop(total);
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  const page = engine.createPage(AGENT);
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-payment-e2e-"));
  const origin = `https://127.0.0.1:${s.port}`;
  const store = await TaskStore.create({ originalRequest: request.replace("SHOP", `127.0.0.1:${s.port}`) }, { storageRoot });
  const browser = new BrowserAdapter({ view: page, permissionMode: "interact" });
  await page.webContents.loadURL(`${origin}/`);
  let turn = 0;
  const controller = new TaskController({
    store, browser, permissionMode: "interact", paymentsEnabled: true, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true,
    planner: { next: async (c) => {
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      if (turn++ > 0) return { ...base, kind: "finish", evidenceIds: [] };
      const button = c.observation.elements.find((e) => e.role === "button" && /place order/i.test(e.name));
      return { ...base, kind: "actions", actions: [{ type: "click", elementId: button.elementId }] };
    } },
  });
  try {
    await controller.start();
    const snap = controller.getSnapshot();
    const notes = (await store.getEvents()).filter((e) => e.type === "note").map((e) => e.payload.kind);
    const ok = s.posts.length === expectPosts && (expectPause ? snap.pauseReason === "need_user" : true);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: posts=${s.posts.length} state=${snap.state}/${snap.pauseReason ?? "-"} queue=${snap.approvalQueue.length} notes=${notes.join(",")}${snap.needUserReason ? ` question="${snap.needUserReason}"` : ""}`);
    return ok;
  } finally {
    await controller.stop().catch(() => {});
    await store.close().catch(() => {});
    await engine.release().catch(() => {});
    await new Promise((resolve) => s.server.close(resolve));
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
}

(async () => {
  if (!CHROMIUM || !process.env.HALO_E2E_KEY || !process.env.HALO_E2E_CERT) { console.error("set HALO_CHROMIUM, HALO_E2E_KEY and HALO_E2E_CERT"); process.exit(2); }
  const results = [];
  results.push(await scenario("clear order within cap pays once", { request: "https://SHOP 에서 $20 이하로 구매해줘", total: "$12.50", expectPosts: 1 }));
  results.push(await scenario("total over the cap asks, shop sees no payment", { request: "https://SHOP 에서 $20 이하로 구매해줘", total: "$25.00", expectPosts: 0, expectPause: true }));
  results.push(await scenario("no payment order: payment waits for a human", { request: "https://SHOP 에서 가격만 알려줘", total: "$12.50", expectPosts: 0 }));
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
