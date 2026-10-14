import http = require("node:http");
import fs = require("node:fs/promises");
import path = require("node:path");
import crypto = require("node:crypto");

interface BridgeOptions {
  root: string;
  methods: readonly string[];
  layout: Record<string, unknown>;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
}
const MAX_BODY = 65_536;
// One voice clip (120 s of 16 kHz mono WAV, base64) is the only call that may exceed MAX_BODY.
const AUDIO_CHANNEL = "halo:transcribeAudio";
const MAX_AUDIO_BODY = 6 * 1024 * 1024;
const EVENTS: Record<string, string> = {
  onEvent: "halo:event", onTaskEvent: "halo:taskEvent", onAgentRosterEvent: "halo:agentRosterEvent",
  onRoomEvent: "halo:roomEvent", onBackgroundRuntimeEvent: "halo:backgroundRuntimeEvent", onSurfaceFrame: "halo:surfaceFrame",
};
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".woff2": "font/woff2", ".ico": "image/x-icon" };

/** One window owns one private loopback origin. Remote pages never get this bridge. */
function createRendererBridge(options: BridgeOptions) {
  const cookieToken = crypto.randomBytes(32).toString("hex");
  const capability = crypto.randomBytes(32).toString("hex");
  const subscribers = new Set<http.ServerResponse>();
  const allowed = new Set(options.methods.map((method) => `halo:${method}`));
  let origin = "";
  let started = false;
  let inflight = 0;
  const cookieName = "halo_renderer";
  const authenticated = (req: http.IncomingMessage) => (req.headers.cookie ?? "").split(/;\s*/).includes(`${cookieName}=${cookieToken}`);
  const server = http.createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  const script = () => `"use strict";
(() => {
  const capability = ${JSON.stringify(capability)};
  const listeners = new Map();
  const api = { runtime: 'chromium', layout: Object.freeze(${JSON.stringify(options.layout)}) };
  // JSON cannot carry binary: a voice clip travels as base64 and the host turns it back into bytes.
  function encodeBinary(value) {
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    if (!view) return value;
    let text = ''; for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
    return { __haloBase64: btoa(text) };
  }
  async function invoke(channel, args) {
    const wire = channel === ${JSON.stringify(AUDIO_CHANNEL)} ? args.map(encodeBinary) : args;
    const response = await fetch('/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-halo-capability': capability, 'x-halo-channel': channel }, body: JSON.stringify({ channel, args: wire }) });
    if (!response.ok) throw new Error('Halo host request failed (' + response.status + ')');
    const body = await response.json();
    if (body.error) { const error = new Error(body.error.message); error.code = body.error.code; throw error; }
    return body.result;
  }
  for (const method of ${JSON.stringify(options.methods)}) api[method] = (...args) => invoke('halo:' + method, args);
  for (const [method, channel] of Object.entries(${JSON.stringify(EVENTS)})) api[method] = (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Event listener must be a function');
    const set = listeners.get(channel) || new Set(); listeners.set(channel, set); set.add(callback);
    return () => set.delete(callback);
  };
  const events = new EventSource('/events');
  events.onmessage = (event) => { const { channel, payload } = JSON.parse(event.data); for (const listener of listeners.get(channel) || []) { try { listener(payload); } catch {} } };
  Object.defineProperty(window, 'haloBrowser', { value: Object.freeze(api), configurable: false, writable: false });
  let resizePending = false;
  const resized = () => { if (resizePending) return; resizePending = true; requestAnimationFrame(() => { resizePending = false; void invoke('halo:windowBounds', [innerWidth, innerHeight]).catch(() => {}); }); };
  addEventListener('resize', resized); resized();
})();`;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress;
    if (!origin || !["127.0.0.1", "::ffff:127.0.0.1"].includes(remote ?? "") || req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "GET" && url.pathname === `/bootstrap/${cookieToken}`) {
      res.setHeader("Set-Cookie", `${cookieName}=${cookieToken}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(303, { Location: "/" }); res.end(); return;
    }
    if (!authenticated(req) || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin" && req.headers["sec-fetch-site"] !== "none")) { res.writeHead(403); res.end(); return; }
    if (url.pathname === "/rpc" && req.method === "POST") {
      if (req.headers.origin !== origin || req.headers["x-halo-capability"] !== capability || req.headers["content-type"] !== "application/json") { res.writeHead(403); res.end(); return; }
      if (inflight >= 16) { res.writeHead(429); res.end(); return; }
      inflight += 1;
      try {
        const parts: Buffer[] = []; let size = 0;
        // The channel is named in a header so the larger audio limit applies before the body is read; the body must agree.
        const sizeLimit = req.headers["x-halo-channel"] === AUDIO_CHANNEL ? MAX_AUDIO_BODY : MAX_BODY;
        for await (const chunk of req) { size += chunk.length; if (size > sizeLimit) { res.writeHead(413); res.end(); return; } parts.push(Buffer.from(chunk)); }
        let body: { channel?: unknown; args?: unknown };
        try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { res.writeHead(400); res.end(); return; }
        if (!body || typeof body.channel !== "string" || (!allowed.has(body.channel) && body.channel !== "halo:windowBounds") || !Array.isArray(body.args)) { res.writeHead(400); res.end(); return; }
        if (size > MAX_BODY && body.channel !== AUDIO_CHANNEL) { res.writeHead(413); res.end(); return; }
        if (body.channel === AUDIO_CHANNEL) body.args = (body.args as unknown[]).map((arg) => { const b64 = (arg as { __haloBase64?: unknown } | null)?.__haloBase64; return typeof b64 === "string" ? Buffer.from(b64, "base64") : arg; });
        res.setHeader("Content-Type", "application/json");
        try { const result = await options.invoke(body.channel, body.args as unknown[]); res.end(JSON.stringify({ result: result ?? null })); }
        catch (error) { const e = error as { code?: string; message?: string }; res.end(JSON.stringify({ error: { code: e.code ?? "host_error", message: e.message ?? "Host request failed" } })); }
      } finally { inflight -= 1; }
      return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    if (url.pathname === "/events") {
      if (subscribers.size >= 4) { res.writeHead(429); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" }); res.write(": ready\n\n");
      subscribers.add(res); req.once("close", () => subscribers.delete(res)); return;
    }
    if (url.pathname === "/halo-bridge.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(script()); return; }
    let relative: string;
    try { relative = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
    const root = await fs.realpath(options.root);
    const target = path.resolve(root, `.${relative === "/" ? "/index.html" : relative}`);
    if (!target.startsWith(`${root}${path.sep}`)) { res.writeHead(404); res.end(); return; }
    try {
      if ((await fs.realpath(target)) !== target || !(await fs.stat(target)).isFile()) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(target);
      if (!MIME[ext]) { res.writeHead(404); res.end(); return; }
      let bytes = await fs.readFile(target);
      // The Electron build ships a meta CSP (connect-src 'none') that would block /rpc and /events; the response header above is this origin's policy.
      if (ext === ".html") bytes = Buffer.from(bytes.toString("utf8").replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, "").replace("<head>", '<head><script src="/halo-bridge.js"></script>'));
      res.writeHead(200, { "Content-Type": MIME[ext] }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  }

  return {
    async start(): Promise<{ url: string; origin: string }> {
      if (!started) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); started = true; }
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      return { origin, url: `${origin}/bootstrap/${cookieToken}` };
    },
    send(channel: string, payload: unknown): void {
      if (!Object.values(EVENTS).includes(channel)) return;
      const bytes = `data: ${JSON.stringify({ channel, payload })}\n\n`;
      for (const res of subscribers) { if (res.writableLength > 1_048_576) { res.destroy(); subscribers.delete(res); } else res.write(bytes); }
    },
    async close(): Promise<void> {
      for (const res of subscribers) res.end(); subscribers.clear();
      if (started) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); started = false; }
    },
  };
}

export = { createRendererBridge };
