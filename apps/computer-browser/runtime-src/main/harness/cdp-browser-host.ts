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
}
interface CdpBrowserHandle { wsUrl: string; launched: boolean; close(): Promise<void> }

const STARTUP_TIMEOUT_MS = 30000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// Flags that cut idle memory and background traffic without weakening isolation.
// Site isolation and the sandbox are deliberately left on.
const LEAN_FLAGS: readonly string[] = Object.freeze([
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
]);
const MAC_CANDIDATES: readonly string[] = Object.freeze([
  // Halo's own lean build (headless_shell: no browser UI, no extensions) is preferred when present.
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

function launchFlags(extra: readonly string[] | undefined, headless: boolean, profile: string, executablePath = ""): string[] {
  for (const flag of extra ?? []) {
    if (typeof flag !== "string" || !flag.startsWith("--") || FORBIDDEN_FLAG.test(flag)) {
      throw new CdpBrowserError("forbidden_flag", `flag is not allowed: ${String(flag).slice(0, 40)}`);
    }
  }
  return [
    ...(headless && !isHeadlessShell(executablePath) ? ["--headless=new", "--disable-gpu"] : []),
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    ...LEAN_FLAGS,
    ...(extra ?? []),
    "about:blank",
  ];
}

async function launchBrowser(executablePath: string, options: CdpBrowserOptions): Promise<CdpBrowserHandle> {
  if (!path.isAbsolute(executablePath) || !fs.existsSync(executablePath)) {
    throw new CdpBrowserError("executable_missing", "executablePath must be an existing absolute path");
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-byo-"));
  const flags = launchFlags(options.extraFlags, options.headless !== false, profile, executablePath);
  const child = childProcess.spawn(executablePath, flags, { stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };
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

export = { CdpBrowserError, LEAN_FLAGS, acquireCdpBrowser, resolveEndpoint, findChromium, launchFlags, isLoopbackEndpoint };
