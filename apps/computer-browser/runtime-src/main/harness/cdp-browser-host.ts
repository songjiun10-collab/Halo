"use strict";

// Bring-your-own Chromium: obtain a CDP connection either by attaching to a
// browser the user already started with --remote-debugging-port, or by
// launching a Chromium/Chrome executable the user points at. The result is the
// browser-level websocket URL that cdp-web-contents.ts connects to.
//
// Trust notes:
//   - An endpoint must be a loopback address. A remote debugging port grants
//     full control of the browser, so Halo never dials a non-local one.
//   - A launched browser always gets a fresh, private profile directory, never
//     the user's own profile, and that directory is removed on close.

import childProcess = require("node:child_process");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

interface CdpBrowserOptions {
  endpoint?: string;        // http(s)://127.0.0.1:9222 or ws://127.0.0.1:9222/devtools/browser/...
  executablePath?: string;  // Chromium/Chrome binary to launch
  extraFlags?: readonly string[];
  headless?: boolean;       // default true
  startupTimeoutMs?: number;
  desktop?: boolean;
  appUrl?: string;
  profilePath?: string;
  extensionDirs?: readonly string[]; // desktop only: unpacked extensions the user installed on purpose
}
// `pid`/`launchedAt` are present only when THIS call spawned the browser.
// MemoryMonitor counts "every process HALO's computer-browser actually
// launches" (memory-monitor.js:3-13), and a browser HALO spawned but never
// registered is invisible to it: app.getAppMetrics() returns Electron's own
// processes only, so a ~145MB idle baseline and a ~650MB heavy-page peak both
// counted as zero. Callers register `pid` on launch and unregister it on close;
// registration pairs pid with launchedAt so a late close cannot unregister a
// newer browser that the OS recycled the pid onto.
//
// Attach mode (`endpoint`) deliberately reports no pid: the user owns that
// browser, and the monitor's contract is about processes we launched.
interface CdpBrowserHandle {
  wsUrl: string;
  launched: boolean;
  pid?: number;
  launchedAt?: number;
  close(): Promise<void>;
}

const STARTUP_TIMEOUT_MS = 30000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// V8 flags must reach the renderer as ONE --js-flags switch. base's CommandLine
// stores switches in a map keyed by name, so a second --js-flags OVERWRITES the
// first rather than merging with it, and the only duplicate-switch handlers in
// the tree are the unit-test and test-launcher ones, which a launched browser
// never installs. Appending our V8 flags after a caller-supplied --js-flags (or
// vice versa) would therefore silently discard --max-old-space-size=512 and hand
// the renderer V8's default, multi-GB heap. jsFlags() is the single place a
// --js-flags switch is built.
const V8_FLAGS: readonly string[] = Object.freeze(["--max-old-space-size=512"]);

function jsFlags(extra?: readonly string[]): string {
  const merged: string[] = [];
  for (const flag of [...V8_FLAGS, ...(extra ?? [])]) {
    if (!merged.includes(flag)) merged.push(flag);
  }
  return `--js-flags=${merged.join(" ")}`;
}

// Flags that cut idle memory and background traffic without weakening isolation.
// Site isolation and the sandbox are deliberately left on. The --js-flags switch
// is NOT listed here: it is assembled in launchFlags() so a caller's own V8
// flags can be folded into the same single switch.
const LEAN_FLAGS: readonly string[] = Object.freeze([
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disk-cache-size=1",
  "--media-cache-size=1",
  // Automation semantics kept on purpose: an offscreen agent page must keep
  // running and render hover/pointer states, and these do not weaken a boundary.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-print-preview",
  "--autoplay-policy=no-user-gesture-required",
  "--enable-automation",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
  // Halo: no self-advertised automation. The UA/client hints stay the stock
  // Chromium ones and navigator.webdriver stays off (chrome patch 3,
  // chromium-patches/0003-Halo-*); the agent's declared identity is the Web Bot
  // Auth signature instead. Builds without the patch ignore the switch.
  "--halo-identity",
]);
const MAC_CANDIDATES: readonly string[] = Object.freeze([
  // Halo's own lean build (headless_shell: no browser UI, no extensions) is preferred when present.
  path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"),
  path.join(os.homedir(), "chromium/src/out/Trial/headless_shell"),
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]);
// Flags a caller may not pass: they would move the profile, loosen the sandbox, or reopen the debug port elsewhere.
const FORBIDDEN_FLAG = /^--(user-data-dir|remote-debugging-(port|address|pipe)|no-sandbox|disable-web-security|remote-allow-origins|load-extension|disable-site-isolation-trials)/;

class CdpBrowserError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CdpBrowserError";
    this.code = code;
  }
}

function isLoopbackEndpoint(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

function findChromium(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const configured = env.HALO_CHROMIUM;
  if (configured && exists(configured)) return configured;
  return MAC_CANDIDATES.find((candidate) => exists(candidate)) ?? null;
}

async function resolveEndpoint(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new CdpBrowserError("invalid_endpoint", "endpoint is not a URL"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new CdpBrowserError("invalid_endpoint", "endpoint must be http(s) or ws(s) without credentials");
  }
  if (!isLoopbackEndpoint(url)) throw new CdpBrowserError("endpoint_not_local", "only a loopback debugging endpoint is allowed");
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
  const versionUrl = new URL("/json/version", url);
  let body: any;
  try {
    const response = await fetchImpl(versionUrl.href, { signal: AbortSignal.timeout(5000) });
    body = await response.json();
  } catch { throw new CdpBrowserError("endpoint_unreachable", "no debugging endpoint answered"); }
  const wsUrl = body?.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string") throw new CdpBrowserError("endpoint_invalid_response", "no webSocketDebuggerUrl in the response");
  const parsed = new URL(wsUrl);
  if (!isLoopbackEndpoint(parsed)) throw new CdpBrowserError("endpoint_not_local", "browser advertised a non-local websocket");
  return parsed.href;
}

// headless_shell is always headless and has no browser UI, so it takes no --headless flag.
function isHeadlessShell(executablePath: string): boolean { return path.basename(executablePath) === "headless_shell"; }

// Width of the leading column (the sidebar) that gets native macOS vibrancy behind it; needs the patched Chromium, other builds ignore the switch.
// Same colour as the sidebar scrim in app.css, painted natively so the blur outside the page's rounded corners matches it.
const DESKTOP_VIBRANCY_TINT = "20,22,21,0.34";
const DESKTOP_VIBRANCY_WIDTH = 244;

function launchFlags(extra: readonly string[] | undefined, headless: boolean, profile: string, executablePath = "", desktop: { desktop?: boolean; appUrl?: string; extensionDirs?: readonly string[] } = {}): string[] {
  for (const flag of extra ?? []) {
    if (typeof flag !== "string" || !flag.startsWith("--") || FORBIDDEN_FLAG.test(flag)) {
      throw new CdpBrowserError("forbidden_flag", `flag is not allowed: ${String(flag).slice(0, 40)}`);
    }
  }
  if (desktop.appUrl) {
    let appUrl: URL;
    try { appUrl = new URL(desktop.appUrl); } catch { throw new CdpBrowserError("invalid_app_url", "desktop URL must be a private loopback origin"); }
    if (!desktop.desktop || appUrl.protocol !== "http:" || appUrl.hostname !== "127.0.0.1" || !appUrl.port || appUrl.username || appUrl.password) throw new CdpBrowserError("invalid_app_url", "desktop URL must be a private loopback origin");
  }
  const extensionDirs = desktop.extensionDirs ?? [];
  if (extensionDirs.length) {
    if (!desktop.desktop) throw new CdpBrowserError("invalid_extension", "only the desktop may load extensions");
    for (const dir of extensionDirs) {
      if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.includes(",") || !fs.existsSync(path.join(dir, "manifest.json"))) throw new CdpBrowserError("invalid_extension", "extension must be an absolute directory with a manifest.json");
    }
  }
  // Fold any caller-supplied V8 flags into the single --js-flags switch instead
  // of appending a second one that would overwrite ours.
  const extraFlags = extra ?? [];
  const callerV8Flags = extraFlags
    .filter((flag) => flag.startsWith("--js-flags="))
    .flatMap((flag) => flag.slice("--js-flags=".length).split(" ").filter(Boolean));
  const passthroughFlags = extraFlags.filter((flag) => !flag.startsWith("--js-flags="));
  return [
    ...(headless && !isHeadlessShell(executablePath) ? ["--headless=new", "--disable-gpu"] : []),
    // headless_shell otherwise renders with SwiftShader and reports an unmistakably software GPU.
    // The Mac's own GPU is what a person's browser reports, so use it (about +16MB per agent browser).
    ...(isHeadlessShell(executablePath) && process.platform === "darwin" ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : []),
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    ...LEAN_FLAGS.filter((flag) => !(desktop.desktop && ["--disable-extensions", "--disable-component-update", "--disable-default-apps", "--enable-automation", "--disk-cache-size=1", "--media-cache-size=1"].includes(flag))),
    // The UI window opens on the primary (Retina) display at a usable size instead of wherever Chromium last left a small 1200px window.
    ...(desktop.desktop ? ["--window-position=40,40", "--window-size=1600,1000", `--halo-vibrancy-width=${DESKTOP_VIBRANCY_WIDTH}`, `--halo-vibrancy-tint=${DESKTOP_VIBRANCY_TINT}`, "--enable-features=GlassFrame,VizBufferQueueDiscardOnVisibilityChange"] : []),
    jsFlags(callerV8Flags),
    ...passthroughFlags,
    ...(extensionDirs.length ? [`--load-extension=${extensionDirs.join(",")}`] : []),
    ...(desktop.appUrl ? [`--app=${desktop.appUrl}`] : ["about:blank"]),
  ];
}

async function launchBrowser(executablePath: string, options: CdpBrowserOptions): Promise<CdpBrowserHandle> {
  if (!path.isAbsolute(executablePath) || !fs.existsSync(executablePath)) {
    throw new CdpBrowserError("executable_missing", "executablePath must be an existing absolute path");
  }
  if (options.profilePath && !options.desktop) throw new CdpBrowserError("invalid_profile", "only the desktop may use a persistent profile");
  const profile = options.profilePath ?? fs.mkdtempSync(path.join(os.tmpdir(), "halo-byo-"));
  if (options.profilePath) {
    if (!path.isAbsolute(profile)) throw new CdpBrowserError("invalid_profile", "desktop profile must be absolute");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(profile);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(profile) !== profile || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new CdpBrowserError("unsafe_profile", "desktop profile must be an owned private directory");
  }
  const flags = launchFlags(options.extraFlags, options.headless !== false, profile, executablePath, options);
  // Generation marker paired with the pid for MemoryMonitor registration. Taken
  // immediately before the spawn so it is strictly ordered against any later
  // browser that might reuse the same pid.
  const launchedAt = Date.now();
  const child = childProcess.spawn(executablePath, flags, { stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = () => { if (!options.profilePath) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } } };
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new CdpBrowserError("startup_timeout", "browser did not report a debugging endpoint")); }, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new CdpBrowserError("exited_early", "browser exited before it was ready")); });
    child.once("error", () => { clearTimeout(timer); reject(new CdpBrowserError("spawn_failed", "browser could not be started")); });
  }).catch((error) => { cleanup(); throw error; });
  return {
    wsUrl,
    launched: true,
    // Reached only after "DevTools listening", so the child exists and has a pid.
    pid: child.pid,
    launchedAt,
    close: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { cleanup(); resolve(); return; }
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(force); cleanup(); resolve(); });
      child.kill("SIGTERM");
    }),
  };
}

// Attach to `endpoint` if given, else launch `executablePath`, else look for an installed Chromium.
async function acquireCdpBrowser(options: CdpBrowserOptions = {}): Promise<CdpBrowserHandle> {
  if (options.endpoint) {
    return { wsUrl: await resolveEndpoint(options.endpoint), launched: false, close: async () => undefined };
  }
  const executable = options.executablePath ?? findChromium();
  if (!executable) throw new CdpBrowserError("no_browser", "set an endpoint, an executablePath or HALO_CHROMIUM");
  return launchBrowser(executable, options);
}

export = { CdpBrowserError, LEAN_FLAGS, V8_FLAGS, jsFlags, acquireCdpBrowser, resolveEndpoint, findChromium, launchFlags, isLoopbackEndpoint, isHeadlessShell };
