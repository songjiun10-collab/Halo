"use strict";

// Developer-only: one REAL model (Codex CLI, default gpt-6-luna) drives a LOCAL fixture page through the real
// TaskController/BrowserAdapter on Chromium. Question: does the model propose hw_step locators, and do they work?
// No external site; at most HALO_HW_MAX_CALLS planner calls (default 10) are spent per run.
//   HALO_DESKTOP_RUNTIME=chromium HALO_CHROMIUM=... node integration/halowright-model-run.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");

const MODEL = process.env.HALO_HW_MODEL || "gpt-6-luna";
const MAX_CALLS = Number(process.env.HALO_HW_MAX_CALLS) > 0 ? Number(process.env.HALO_HW_MAX_CALLS) : 10;

// Local fixtures with deliberate traps. Success is judged from the page's own state, not from the model's claim.
const CASES = {
  signup: {
    goal: "On this page, subscribe b@c.dev to the Pro plan using the Subscribe button.",
    expect: "Subscribed: b@c.dev / pro",
    // A distractor link, and a submit button that is rendered late and starts disabled.
    page: `<!doctype html><title>Signup</title><h1>Newsletter</h1><form onsubmit="return false">
<label for="email">Email address</label><input id="email" type="email">
<label for="plan">Plan</label><select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select><div id="slot"></div></form>
<p><a href="#" onclick="return false">Unsubscribe from other lists</a></p><p id="result"></p>
<script>setTimeout(()=>{const b=document.createElement("button");b.textContent="Subscribe";b.disabled=true;b.onclick=()=>{result.textContent="Subscribed: "+email.value+" / "+plan.value};slot.appendChild(b);setTimeout(()=>{b.disabled=false},400)},300)</script>`,
  },
  cart: {
    goal: "Add the product named Blue Mug to the cart. Several products have an Add to cart button; choose the one for Blue Mug.",
    expect: "Cart: Blue Mug",
    // Three identical "Add to cart" buttons: the locator must be scoped to the right product.
    page: `<!doctype html><title>Shop</title><h1>Shop</h1>
<section aria-label="Red Mug"><h2>Red Mug</h2><button onclick="cart.textContent='Cart: Red Mug'">Add to cart</button></section>
<section aria-label="Blue Mug"><h2>Blue Mug</h2><button onclick="cart.textContent='Cart: Blue Mug'">Add to cart</button></section>
<section aria-label="Green Mug"><h2>Green Mug</h2><button onclick="cart.textContent='Cart: Green Mug'">Add to cart</button></section><p id="cart"></p>`,
  },
  prefs: {
    goal: "Turn on Email alerts, choose Weekly digest, type 'solar' in the search box and press Enter to search.",
    expect: "alerts=on;digest=weekly;search=solar",
    // Checkbox + radio + a search that only runs on Enter.
    page: `<!doctype html><title>Prefs</title><h1>Preferences</h1>
<label><input id="alerts" type="checkbox"> Email alerts</label>
<fieldset><legend>Digest</legend><label><input type="radio" name="d" value="daily"> Daily digest</label><label><input type="radio" name="d" value="weekly"> Weekly digest</label></fieldset>
<label for="q">Search</label><input id="q" type="search" onkeydown="if(event.key==='Enter')out.textContent='alerts='+(alerts.checked?'on':'off')+';digest='+((document.querySelector('input[name=d]:checked')||{}).value||'none')+';search='+q.value"><p id="out"></p>`,
  },
};
const CASE = CASES[process.env.HALO_HW_CASE || "signup"];
if (!CASE) throw new Error("unknown HALO_HW_CASE");
const RESULT_ID = { signup: "result", cart: "cart", prefs: "out" }[process.env.HALO_HW_CASE || "signup"];

async function main() {
  const server = http.createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end(CASE.page); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "halo-hwmodel-"));
  const launched = await acquireCdpBrowser({ headless: true });
  const view = await openCdpView(launched.wsUrl, { width: 1280, height: 800 });
  const browser = new BrowserAdapter({ view, navigationTimeoutMs: 20000 });
  const executed = [];
  const execute = browser.execute.bind(browser);
  browser.execute = async (action, options) => { const result = await execute(action, options); executed.push({ type: action.type, step: action.step?.op, locator: action.step?.locator, status: result?.status, errorCode: result?.errorCode, effect: result?.effect }); return result; };
  await browser.execute({ type: "navigate", url: `http://127.0.0.1:${server.address().port}/` });
  executed.length = 0;
  const store = await TaskStore.create({
    originalRequest: CASE.goal,
    criteria: [{ id: "done", text: CASE.goal, required: true, verification: "user" }],
    limits: { maxActions: 20, maxPlannerCalls: MAX_CALLS, maxActiveMs: 120000 },
  }, { storageRoot: path.join(root, "store") });
  const usages = [];
  const planner = new PlannerStdioAdapter({ command: process.execPath, args: [path.resolve(__dirname, "../main/harness/providers/codex-planner-worker.js"), "--model", MODEL], cwd: path.resolve(__dirname, ".."), timeoutMs: 60000, onUsage: (usage) => usages.push(usage) });
  const proposals = [];
  const started = Date.now();
  const controller = new TaskController({
    store, browser, permissionMode: "browse", harnessProfile: "middle", plannerEffort: "medium", hostVerifier: () => false,
    approve: async () => ({ decision: "allow", reasons: [] }),
    planner: { close: () => planner.close(), next: async (context, options) => {
      if (process.env.HALO_HW_DUMP && proposals.length === 3) console.error('CTX', JSON.stringify({ keys: Object.keys(context), recent: context.recentActions ?? context.history ?? null, obs: context.observation && { text: String(context.observation.text).slice(0, 400), els: (context.observation.elements ?? []).slice(0, 12) } }).slice(0, 3000));
      const proposal = await planner.next(context, options);
      proposals.push({ kind: proposal.kind, actions: (proposal.actions ?? []).map((a) => a.type === "hw_step" ? `hw_step:${a.step?.op}` : a.type) });
      return proposal;
    } },
  });
  let snapshot = await controller.start();
  let approvals = 0;
  while (snapshot.state === "awaiting_approval" && approvals < 10) { approvals += 1; snapshot = await controller.approve(snapshot.approvalQueue[0].id); }
  const result = await view.webContents.executeJavaScript("document.getElementById('" + RESULT_ID + "').textContent");
  const report = { case: process.env.HALO_HW_CASE || "signup", model: MODEL, wallMs: Date.now() - started, plannerCalls: proposals.length, state: snapshot.state, pauseReason: snapshot.pauseReason ?? null, humanApprovals: approvals, pageResult: result, success: result === CASE.expect, proposals, executed, usageInputTokens: usages.reduce((n, u) => n + (u?.inputTokens ?? 0), 0) };
  console.log(JSON.stringify(report, null, 1));
  await controller.stop().catch(() => {});
  await planner.close?.();
  try { view.closeConnection(); } catch { /* ignore */ }
  await launched.close?.();
  await store.close().catch(() => {});
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(report.success ? 0 : 1);
}
main().catch((error) => { console.error("ERR", error?.message ?? error); process.exit(2); });
