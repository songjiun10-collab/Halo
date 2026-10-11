"use strict";

// TEMPORARY measurement probe. Breaks ONE harness turn into its real stages
// against a real Chromium page and a fake planner, so harness cost is separable
// from model latency.
//
//   node integration/probe-turn-stages.js [turns] [route]
//
// route: "text" (planner without image input) | "image" (image-capable planner)
//
// Stages measured:
//   observe      browser.observe()  -- one CDP evaluate of the page snapshot
//   capture      captureTextObservation / captureComputerUseObservation
//   context      buildContext() + the JSON size of the packet sent to the planner
//   store        the durable appends TaskController makes around a turn
//   planner      FAKE, always 0 ms -- deliberately excluded from every verdict
//
// This does NOT measure page load, model latency, or task success rate.

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const crypto = require("node:crypto");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { TaskStore } = require("../main/harness/task-store");
const { buildContext } = require("../main/harness/context-builder");
const { capturePreferredObservation } = require("../main/harness/computer-use-observation");
const { captureFrameJpeg } = require("../main/harness/frame-capture");
const contracts = require("../shared/harness-contracts");

const CHROMIUM = process.env.HALO_CHROMIUM
  || path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium");

const TURNS = Number(process.argv[2]) || 30;
const ROUTE = process.argv[3] === "image" ? "image" : "text";

// A realistic-ish local page: enough DOM that the snapshot has work to do.
function pageHtml(n) {
  const rows = Array.from({ length: n }, (_, i) =>
    `<section><h2>Item ${i}</h2><p>Paragraph body for item ${i} with some readable text content.</p>`
    + `<a href="/item/${i}">Open item ${i}</a><button>Act ${i}</button>`
    + `<input name="f${i}" placeholder="Field ${i}"></section>`).join("\n");
  return `<!doctype html><html><head><title>probe</title></head><body><h1>Probe page</h1>${rows}</body></html>`;
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))];
  return { count: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted.at(-1).toFixed(2),
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) };
}

function report(title, samples) {
  const s = stats(samples);
  if (!s) { console.log(`${title.padEnd(10)} (no samples)`); return; }
  console.log(`${title.padEnd(10)} n=${String(s.count).padStart(3)}  p50=${String(s.p50).padStart(8)}  p95=${String(s.p95).padStart(8)}  max=${String(s.max).padStart(8)}  mean=${String(s.mean).padStart(8)}`);
}

async function main() {
  const body = pageHtml(60);
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(body); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const view = await openCdpView(launched.wsUrl, { width: 1440, height: 900 });
  const browser = new BrowserAdapter({ view, navigationTimeoutMs: 20000 });
  // captureTextObservation lives on AgentViewportHost, which composes it over a
  // BrowserAdapter. The probe borrows that composition instead of reimplementing it.
  const captureHost = {
    captureTextObservation: async (observation) => {
      const geometry = await browser.captureScreenGeometry(observation);
      const { buildScreenMap } = require("../main/harness/screen-map");
      const screenMap = buildScreenMap(Array.isArray(observation.elements) ? observation.elements : [], geometry.boxes);
      const binding = Object.freeze({
        observationId: geometry.observationId, taskId: store.taskId, agentId: null,
        documentEpoch: geometry.documentEpoch, origin: new URL(geometry.url).origin,
        capturedAt: Date.now(), viewport: Object.freeze({ ...geometry.viewport }),
        digest: require("node:crypto").createHash("sha256").update(screenMap.text).digest("hex"),
      });
      browser.authorizeVisualBinding(binding);
      return { binding, screenMap };
    },
  };
  await browser.execute({ type: "navigate", url: `${base}/` });

  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-turn-probe-"));
  const store = await TaskStore.create({
    originalRequest: "Read the item list and report item 7's title.",
    criteria: [{ id: "done", text: "reported", required: true, verification: "host" }],
    limits: { maxActions: 50, maxPlannerCalls: 50, maxActiveMs: 600000 },
  }, { storageRoot });

  const samples = { observe: [], capture: [], context: [], store: [], journalOnly: [], frameMirror: [], turn: [] };
  const byteSamples = { context: [], screenMap: [] };
  let previousActionType = null;
  let previousActionStatus = null;
  let lastCapture = null;

  for (let turn = 0; turn < TURNS; turn += 1) {
    const turnStart = performance.now();

    let t = performance.now();
    const observation = await browser.observe();
    samples.observe.push(performance.now() - t);

    // What the controller does after observe(): one note + a checkpoint's worth
    // of durable work, so the store column reflects one turn.
    t = performance.now();
    await store.append({ type: "note", payload: { msg: `turn ${turn} observed ${observation.url}` } });
    samples.journalOnly.push(performance.now() - t);
    t = performance.now();
    await store.checkpoint({ task: { state: "running", pauseReason: null }, turn });
    samples.store.push(performance.now() - t);

    t = performance.now();
    let capture;
    try {
      capture = await capturePreferredObservation(captureHost, observation, {
        taskId: store.taskId, imageInput: ROUTE === "image",
        lastActionType: previousActionType, lastActionStatus: previousActionStatus,
      });
    } catch (error) {
      console.log(`turn ${turn}: capture failed: ${error.code ?? error.message}`);
      continue;
    }
    samples.capture.push(performance.now() - t);
    if (capture.textCapture) byteSamples.screenMap.push(Buffer.byteLength(capture.textCapture.screenMap.text, "utf8"));
    if (capture.visualCapture) byteSamples.screenMap.push(capture.visualCapture.screenTargets?.length ?? 0);

    const plannerObservation = capture.visualCapture
      ? { ...observation, computerUse: { ...capture.visualCapture.binding } }
      : capture.textCapture
        ? { ...observation, computerUse: { ...capture.textCapture.binding, mode: "text" }, screenMap: capture.textCapture.screenMap.text }
        : observation;

    t = performance.now();
    const context = buildContext({
      goal: store.getGoal(),
      state: { budgets: { plannerCallsUsed: turn, actionsUsed: turn } },
      navigation: { visited: [base], frontier: [] },
      observation: plannerObservation,
      recentEvents: store.eventsSinceCheckpoint || [],
    });
    samples.context.push(performance.now() - t);
    byteSamples.context.push(Buffer.byteLength(JSON.stringify(context), "utf8"));

    // The user-facing live mirror poll, which runs on its own cadence.
    t = performance.now();
    await captureFrameJpeg(view.webContents, { maxWidth: 1200, quality: 65 }).catch(() => null);
    samples.frameMirror.push(performance.now() - t);

    await capture.visualCapture?.attachment?.dispose?.();
    lastCapture = capture;
    previousActionType = "navigate";
    previousActionStatus = "ok";
    samples.turn.push(performance.now() - turnStart);
  }

  await store.close();
  await browser.dispose?.();
  view.closeConnection?.();
  await launched.close().catch(() => undefined);
  await new Promise((r) => server.close(r));
  await fs.rm(storageRoot, { recursive: true, force: true });

  console.log(`\nroute=${ROUTE}  turns=${TURNS}  page=60 sections  viewport=1440x900`);
  console.log(`(all times ms, single sample per stage per turn, no concurrency)\n`);
  report("observe", samples.observe);
  report("capture", samples.capture);
  report("context", samples.context);
  report("journal", samples.journalOnly);
  report("checkpoint", samples.store);
  report("mirror", samples.frameMirror);
  report("TURN", samples.turn);

  const c = stats(byteSamples.context), s = stats(byteSamples.screenMap);
  console.log(`\ncontext packet bytes: p50=${c.p50} p95=${c.p95} max=${c.max} (limit ${contracts.MAX_CONTEXT_PACKET_BYTES})`);
  if (ROUTE === "text") console.log(`screenMap bytes       : p50=${s.p50} p95=${s.p95} max=${s.max}`);
  console.log(`route taken by capturePreferredObservation: ${lastCapture?.route} (reason: ${lastCapture?.reason})`);
}

main().then(() => process.exit(0), (error) => { console.error(error?.stack ?? error); process.exit(1); });