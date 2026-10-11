"use strict";

// TEMPORARY measurement probe (not a test). Decisive on-screen measurement of
// whether the first native Chromium patch (ee502d2c, --halo-vibrancy-width)
// makes the leading 244pt of an --app window translucent / tracking what is
// behind it, versus a flat opaque fill in the unpatched build.
//
// Method (per arm, one browser process):
//   - launch the arm's Chromium with the exact Halo desktop flag set
//     (launchFlags(): --window-position=40,40 --window-size=1600,1000
//     --halo-vibrancy-width=244 --halo-vibrancy-tint=20,22,21,0.34
//     --enable-features=GlassFrame) and --app=<local transparent test page>.
//     The test page leaves the leading 244px fully transparent and paints
//     #101010 everywhere right of 244px (opaque control region).
//   - create a second (normal) window in the SAME process over CDP
//     (Target.createTarget newWindow). Same-app windows have deterministic
//     z-order, so Page.bringToFront on the test window reliably puts the test
//     window above the background window; no cross-app activation games.
//   - resize the background window to the whole screen (Browser.setWindowBounds)
//     and switch its <html> background between known colours over CDP.
//   - for each colour take one full-screen `screencapture -x` and decode it
//     with pure zlib; measure the leading strip (several sub-regions), the
//     opaque page control region, and the bare background outside the test
//     window. Also detect the x of the transparent(#101010) page edge and, for
//     the two-tone background, a horizontal colour profile across the strip to
//     see whether the red/blue boundary is smeared (blur) or sharp.
//
//   node integration/tmp-vibrancy-glass-measure.js
//
// Captures + report.json are written to a temp dir printed at the end.

const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { launchFlags } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport } = require("../main/harness/cdp-web-contents");

const HOME = os.homedir();
const ARMS = [
  { name: "patched", binary: path.join(HOME, "chromium/src/out/TrialLean/Chromium.app/Contents/MacOS/Chromium") },
  { name: "unpatched", binary: path.join(HOME, "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium") },
];

// Screen is 1710x1112 logical points (captures are 2x = 3420x2224).
const SCREEN = { width: 1710, height: 1112 };
// Test window: outer top-left at (40,40), 1600x1000 (Halo desktop flags).
const TEST_X = 40;
const TEST_Y = 40;
const TEST_W = 1600;
const TEST_H = 1000;
const VIBRANCY_W = 244;

// Logical-point regions of the full-screen capture: [x0, y0, x1, y1]
const REGIONS = {
  stripMid: [50, 300, 272, 900],      // leading strip, well inside 0..244
  stripUpper: [50, 120, 272, 300],    // strip just below traffic lights
  stripLeft: [50, 300, 150, 900],     // left of the two-tone split (screen x=162)
  stripRight: [180, 300, 272, 900],   // right of the split
  pageControl: [330, 120, 1330, 1000],// page area right of 244px: must be opaque #101010
  bgLeft: [2, 300, 30, 700],          // bare background left of the test window
  bgRight: [1660, 300, 1706, 700],    // bare background right of the test window
};

const BACKGROUNDS = [
  { name: "red", css: "#ff0000", expectRight: "red" },
  { name: "blue", css: "#0000ff", expectRight: "blue" },
  { name: "green", css: "#00ff00", expectRight: "green" },
  {
    name: "splitRB",
    css: "linear-gradient(90deg, #ff0000 0px, #ff0000 162px, #0000ff 162px, #0000ff 1710px)",
    expectRight: "blue",
  },
];

const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "halo-glass-shots-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------ screen state guards

function screenLocked() {
  try {
    const out = execFileSync("ioreg", ["-n", "Root", "-d1", "-l"], { encoding: "utf8", timeout: 5000 });
    return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(out);
  } catch {
    return false; // unknown; capture validation catches reality
  }
}

async function waitForUnlockedScreen(label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (!screenLocked()) return true;
    if (!announced) {
      console.error(`[${label}] screen is LOCKED (captures would show the lock screen); waiting up to ${Math.round(timeoutMs / 60000)} min for unlock`);
      announced = true;
    }
    try { execFileSync("caffeinate", ["-u", "-t", "1"], { timeout: 5000 }); } catch { /* keep trying */ }
    await sleep(5000);
  }
  return false;
}

function imageIsUniformBlack(img) {
  const { width, height, channels, data } = img;
  for (let y = 0; y < height; y += 53) {
    for (let x = 0; x < width; x += 41) {
      const i = (y * width + x) * channels;
      if (data[i] > 2 || data[i + 1] > 2 || data[i + 2] > 2) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- PNG decode

function decodePng(buf) {
  let pos = 8;
  let width, height, bitDepth, colorType;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (!channels || bitDepth !== 8) throw new Error(`unsupported png: colorType=${colorType} bitDepth=${bitDepth}`);
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      } else if (filter !== 0) throw new Error(`bad filter ${filter}`);
      cur[i] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

// logical-point region -> stats on the 2x image
function regionStats(img, [x0, y0, x1, y1]) {
  const px = (v) => Math.round(v * 2);
  x0 = Math.max(0, px(x0)); y0 = Math.max(0, px(y0));
  x1 = Math.min(img.width, px(x1)); y1 = Math.min(img.height, px(y1));
  let n = 0, sr = 0, sg = 0, sb = 0, sr2 = 0, sg2 = 0, sb2 = 0;
  let minL = 255, maxL = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * img.channels;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      sr += r; sg += g; sb += b; sr2 += r * r; sg2 += g * g; sb2 += b * b; n++;
      const l = (r + g + b) / 3;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
  }
  const sd = (s, s2) => Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  return {
    region: [x0 / 2, y0 / 2, x1 / 2, y1 / 2],
    pixels: n,
    mean: [sr / n, sg / n, sb / n].map((v) => Number(v.toFixed(1))),
    sd: [sd(sr, sr2), sd(sg, sg2), sd(sb, sb2)].map((v) => Number(v.toFixed(2))),
    lumaMin: Number(minL.toFixed(1)),
    lumaMax: Number(maxL.toFixed(1)),
  };
}

function classify(mean) {
  const [r, g, b] = mean;
  if (r > 150 && r - g > 60 && r - b > 60) return "red";
  if (g > 150 && g - r > 60 && g - b > 60) return "green";
  if (b > 150 && b - r > 60 && b - g > 60) return "blue";
  if (r < 45 && g < 45 && b < 45) return "dark";
  if (r > 200 && g > 200 && b > 200) return "white";
  return "other";
}

// x (logical) of the first run of #101010-ish pixels on one image row
function mainEdgeLogical(img, yLogical) {
  const { width, channels, data } = img;
  const y = Math.round(yLogical * 2);
  let run = 0;
  for (let x = 200; x < width - 100; x++) {
    const i = (y * width + x) * channels;
    const dark = Math.abs(data[i] - 16) <= 5 && Math.abs(data[i + 1] - 16) <= 5 && Math.abs(data[i + 2] - 16) <= 5;
    run = dark ? run + 1 : 0;
    if (run >= 24) return (x - 23) / 2;
  }
  return null;
}

function rowProfile(img, yLogical, x0Logical, x1Logical, stepLogical) {
  const out = [];
  const y = Math.round(yLogical * 2);
  for (let x = x0Logical; x <= x1Logical; x += stepLogical) {
    const i = (y * img.width + Math.round(x * 2)) * img.channels;
    out.push([x, img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  return out;
}

// ------------------------------------------------------------- CDP plumbing

function launch(binary, flags, tag, timeoutMs) {
  const child = spawn(binary, flags, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr.setEncoding("utf8");
  let buffer = "";
  const wsUrl = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag}: startup_timeout after ${timeoutMs}ms; stderr_tail=${buffer.slice(-400)}`)), timeoutMs);
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`${tag}: exited_early code=${code} signal=${signal}; stderr_tail=${buffer.slice(-400)}`)); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  wsUrl.catch(() => {}); // the real error is surfaced where wsUrl is awaited
  return { child, wsUrl, flags, tag };
}

async function waitForPage(transport, urlPrefix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const targets = await transport.send("Target.getTargets");
    const page = targets.targetInfos.find((t) => t.type === "page" && String(t.url).startsWith(urlPrefix));
    if (page) return page;
    last = targets.targetInfos.map((t) => `${t.type}:${t.url}`).join(" | ");
    await sleep(300);
  }
  throw new Error(`no page target for ${urlPrefix}; saw ${last.slice(0, 500)}`);
}

async function evaluate(transport, sessionId, expression) {
  const reply = await transport.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (reply.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 300)}`);
  return reply.result?.value;
}

async function waitReady(transport, sessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await evaluate(transport, sessionId, "document.readyState")) === "complete") return true; } catch { /* keep polling */ }
    await sleep(250);
  }
  return false;
}

async function attach(transport, targetId) {
  const { sessionId } = await transport.send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

// ------------------------------------------------------------------- server

function handler(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/test") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>halo glass test</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #main { position: fixed; left: ${VIBRANCY_W}px; top: 0; right: 0; bottom: 0; background: #101010; }
  #marker { position: fixed; left: ${VIBRANCY_W}px; top: 0; right: 0; height: 2px; background: #00ffff; }
</style>
<div id="main"></div><div id="marker"></div>`);
    return;
  }
  if (url.pathname === "/bg") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>halo glass background</title>
<style>html, body { margin: 0; padding: 0; overflow: hidden; background: #ff0000; }</style>`);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("nope");
}

// ------------------------------------------------------------------- runner

async function captureAndAnalyze(tag, background) {
  let file = path.join(SHOTS, `${tag}.png`);
  execFileSync("screencapture", ["-x", file], { timeout: 30000 });
  let img = decodePng(fs.readFileSync(file));
  let displayWakeRetries = 0;
  for (let i = 0; i < 3 && imageIsUniformBlack(img); i++) {
    displayWakeRetries++;
    console.error(`[${tag}] capture was uniformly black (display asleep); waking display and retrying`);
    try { execFileSync("caffeinate", ["-u", "-t", "2"], { timeout: 8000 }); } catch { /* keep trying */ }
    await sleep(2500);
    file = path.join(SHOTS, `${tag}-wake${displayWakeRetries}.png`);
    execFileSync("screencapture", ["-x", file], { timeout: 30000 });
    img = decodePng(fs.readFileSync(file));
  }
  if (imageIsUniformBlack(img)) throw new Error(`${tag}: display stayed black; cannot measure`);
  if (img.width !== SCREEN.width * 2 || img.height !== SCREEN.height * 2) {
    throw new Error(`unexpected capture size ${img.width}x${img.height} (expected ${SCREEN.width * 2}x${SCREEN.height * 2})`);
  }
  const regions = {};
  for (const [name, region] of Object.entries(REGIONS)) regions[name] = regionStats(img, region);
  const result = {
    file,
    displayWakeRetries,
    regions,
    mainEdgeLogicalX: mainEdgeLogical(img, 500),
    classes: {
      stripMid: classify(regions.stripMid.mean),
      stripLeft: classify(regions.stripLeft.mean),
      stripRight: classify(regions.stripRight.mean),
      pageControl: classify(regions.pageControl.mean),
      bgLeft: classify(regions.bgLeft.mean),
      bgRight: classify(regions.bgRight.mean),
    },
  };
  if (background.name === "splitRB") {
    result.splitProfile = rowProfile(img, 500, 20, 320, 4); // [logicalX, r, g, b]
  }
  return result;
}

function captureValid(result, background) {
  const geometry = result.mainEdgeLogicalX !== null &&
    Math.abs(result.mainEdgeLogicalX - (TEST_X + VIBRANCY_W)) <= 8;
  const pageOpaque = result.classes.pageControl === "dark" && Math.max(...result.regions.pageControl.sd) <= 5;
  const bgVisible = result.classes.bgRight === background.expectRight;
  return { geometry, pageOpaque, bgVisible, ok: geometry && pageOpaque && bgVisible };
}

async function runArm(arm, port) {
  if (!fs.existsSync(arm.binary)) throw new Error(`missing binary ${arm.binary}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `halo-glass-${arm.name}-`));
  const testUrl = `http://127.0.0.1:${port}/test`;
  const bgUrl = `http://127.0.0.1:${port}/bg`;
  const flags = launchFlags(undefined, false, profile, arm.binary, { desktop: true, appUrl: testUrl });
  const haloFlagsPresent = flags.includes(`--halo-vibrancy-width=${VIBRANCY_W}`) && flags.includes("--halo-vibrancy-tint=20,22,21,0.34");
  console.error(`[${arm.name}] launching ${arm.binary}`);
  const browser = launch(arm.binary, flags, `${arm.name}-browser`, arm.name === "patched" ? 120000 : 300000);
  let transport = null;
  const captures = [];
  try {
    transport = await connectCdpTransport(await browser.wsUrl);
    const testPage = await waitForPage(transport, testUrl, 60000);
    const testSession = await attach(transport, testPage.targetId);
    await waitReady(transport, testSession);

    // Background window in the same process (same-app z-order is deterministic).
    const created = await transport.send("Target.createTarget", { url: bgUrl, newWindow: true });
    const bgSession = await attach(transport, created.targetId);
    await waitReady(transport, bgSession);
    let bgBoundsNote = "set";
    try {
      const { windowId, bounds } = await transport.send("Browser.getWindowForTarget", { targetId: created.targetId });
      await transport.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 0, top: 0, width: SCREEN.width, height: SCREEN.height, windowState: "normal" },
      });
      bgBoundsNote = `set from ${JSON.stringify(bounds)}`;
    } catch (error) {
      bgBoundsNote = `setWindowBounds failed: ${String(error?.message || error)}`;
    }
    console.error(`[${arm.name}] background window ${bgBoundsNote}`);

    // Test window on top (same app: raise is deterministic).
    await transport.send("Page.bringToFront", {}, testSession).catch(() => {});
    await sleep(2500); // first paint + vibrancy settle

    for (const background of BACKGROUNDS) {
      const tag = `${arm.name}-${background.name}`;
      if (screenLocked() && !(await waitForUnlockedScreen(tag, 15 * 60 * 1000))) {
        throw new Error(`${tag}: screen relocked; cannot measure`);
      }
      await evaluate(transport, bgSession,
        `(() => { document.documentElement.style.background = ${JSON.stringify(background.css)}; document.documentElement.style.overflow = "hidden"; document.body.style.background = "transparent"; return document.documentElement.style.background; })()`);
      await transport.send("Page.bringToFront", {}, testSession).catch(() => {});
      await sleep(1000);

      let result = await captureAndAnalyze(tag, background);
      let validity = captureValid(result, background);
      let attempts = 1;
      if (!validity.ok) {
        // One retry: re-raise the test window (it must be the visible top window).
        console.error(`[${arm.name}/${background.name}] first capture not valid: ${JSON.stringify(validity)}; retrying`);
        await transport.send("Page.bringToFront", {}, testSession).catch(() => {});
        await sleep(2000);
        result = await captureAndAnalyze(`${tag}-retry`, background);
        validity = captureValid(result, background);
        attempts = 2;
      }
      captures.push({ background: background.name, expected: background, attempts, validity, ...result });
      console.error(`[${arm.name}/${background.name}] stripMid=${JSON.stringify(result.regions.stripMid.mean)} sd=${JSON.stringify(result.regions.stripMid.sd)} valid=${validity.ok}`);
    }

    return { arm: arm.name, binary: arm.binary, flags, haloFlagsPresent, captures };
  } finally {
    if (transport) transport.close();
    await killTree(browser.child, profile);
  }
}

async function killTree(child, profile) {
  if (child && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    for (let i = 0; i < 15 && child.exitCode === null && child.signalCode === null; i++) await sleep(200);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }
  if (profile) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(400); }
    }
  }
}

// ------------------------------------------------------------------ summary

function summarize(report) {
  const out = {};
  for (const arm of report.arms) {
    const byName = Object.fromEntries(arm.captures.map((c) => [c.background, c]));
    const meanOf = (bg, region) => byName[bg]?.regions?.[region]?.mean ?? null;
    const sdOf = (bg, region) => byName[bg]?.regions?.[region]?.sd ?? null;
    const chanAbsDiff = (a, b) => (a && b ? a.map((v, i) => Number(Math.abs(v - b[i]).toFixed(1))) : null);
    const maxAbsDiff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : null);
    const split = byName.splitRB;
    out[arm.name] = {
      flagsHaveHaloSwitches: arm.haloFlagsPresent,
      allCapturesValid: arm.captures.every((c) => c.validity.ok),
      stripMid: {
        red: meanOf("red", "stripMid"),
        blue: meanOf("blue", "stripMid"),
        green: meanOf("green", "stripMid"),
        splitRB: meanOf("splitRB", "stripMid"),
        sd: { red: sdOf("red", "stripMid"), blue: sdOf("blue", "stripMid") },
        redVsBlueChannelDeltas: chanAbsDiff(meanOf("red", "stripMid"), meanOf("blue", "stripMid")),
        maxRedBlueDelta: maxAbsDiff(meanOf("red", "stripMid"), meanOf("blue", "stripMid")),
      },
      splitRB: {
        stripLeft: meanOf("splitRB", "stripLeft"),
        stripRight: meanOf("splitRB", "stripRight"),
        leftMinusRight: split ? split.regions.stripLeft.mean.map((v, i) => Number((v - split.regions.stripRight.mean[i]).toFixed(1))) : null,
      },
      pageControl: {
        red: meanOf("red", "pageControl"),
        blue: meanOf("blue", "pageControl"),
        maxRedBlueDelta: maxAbsDiff(meanOf("red", "pageControl"), meanOf("blue", "pageControl")),
      },
      bgRight: {
        red: meanOf("red", "bgRight"),
        blue: meanOf("blue", "bgRight"),
        green: meanOf("green", "bgRight"),
        splitRB: meanOf("splitRB", "bgRight"),
      },
    };
  }
  const P = out.patched, U = out.unpatched;
  let verdict = "inconclusive";
  if (P && U) {
    const patchedTracks = P.stripMid.maxRedBlueDelta >= 10;
    const patchedSplitSeparates = P.splitRB.leftMinusRight && (P.splitRB.leftMinusRight[0] >= 20 || P.splitRB.leftMinusRight[2] >= 20);
    const unpatchedFlat = U.stripMid.maxRedBlueDelta <= 3;
    const patchedDiffersFromUnpatched = maxDiff(P.stripMid.red, U.stripMid.red) >= 5;
    if (patchedTracks && unpatchedFlat && patchedSplitSeparates && patchedDiffersFromUnpatched) verdict = "glass_confirmed";
    else if (!patchedTracks && unpatchedFlat) verdict = "not_confirmed_patched_strip_does_not_track_background";
    else if (!unpatchedFlat) verdict = "inconclusive_patched_or_unpatched_invalid";
  }
  return {
    patchedStripMaxRedBlueDelta: P?.stripMid?.maxRedBlueDelta ?? null,
    unpatchedStripMaxRedBlueDelta: U?.stripMid?.maxRedBlueDelta ?? null,
    patchedSplitLeftMinusRight: P?.splitRB?.leftMinusRight ?? null,
    unpatchedSplitLeftMinusRight: U?.splitRB?.leftMinusRight ?? null,
    patchedVsUnpatchedRedStrip: maxDiff(P?.stripMid?.red, U?.stripMid?.red),
    verdict,
  };
  function maxDiff(a, b) {
    return a && b ? Number(Math.max(...a.map((v, i) => Math.abs(v - b[i]))).toFixed(1)) : null;
  }
}

// --------------------------------------------------------------------- main

async function main() {
  for (const arm of ARMS) if (!fs.existsSync(arm.binary)) throw new Error(`missing ${arm.binary}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  let caffeinate = null;
  // -u keeps the display awake and stops idle locking for the whole run.
  try { caffeinate = spawn("caffeinate", ["-d", "-i", "-m", "-u"], { stdio: "ignore" }); } catch { /* best effort */ }
  if (!(await waitForUnlockedScreen("main", 45 * 60 * 1000))) {
    throw new Error("screen stayed locked; on-screen translucency cannot be measured until the user unlocks");
  }
  console.error("[main] screen unlocked; measuring");
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const report = { generatedAt: new Date().toISOString(), shotsDir: SHOTS, port, screen: SCREEN, arms: [] };
  try {
    for (const arm of ARMS) report.arms.push(await runArm(arm, port));
  } finally {
    server.close();
    if (caffeinate) caffeinate.kill("SIGTERM");
    // targeted safety sweep: only processes carrying our unique profile prefixes
    for (const pattern of ["halo-glass-patched-", "halo-glass-unpatched-"]) {
      try { execFileSync("pkill", ["-f", pattern], { timeout: 5000 }); } catch { /* none left */ }
    }
  }
  report.summary = summarize(report);
  fs.writeFileSync(path.join(SHOTS, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
