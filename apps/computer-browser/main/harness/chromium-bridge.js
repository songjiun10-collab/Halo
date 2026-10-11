// Generated from runtime-src/main/harness/chromium-bridge.ts. Do not edit; run npm run build:runtime.
"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_BODY = 65_536;
const EVENTS = {
    onEvent: "halo:event", onTaskEvent: "halo:taskEvent", onAgentRosterEvent: "halo:agentRosterEvent",
    onRoomEvent: "halo:roomEvent", onBackgroundRuntimeEvent: "halo:backgroundRuntimeEvent", onSurfaceFrame: "halo:surfaceFrame", onAgentFrame: "halo:agentFrame",
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".woff2": "font/woff2", ".ico": "image/x-icon" };
/** One window owns one private loopback origin. Remote pages never get this bridge. */
function createRendererBridge(options) {
    const cookieToken = crypto.randomBytes(32).toString("hex");
    const capability = crypto.randomBytes(32).toString("hex");
    const subscribers = new Set();
    const allowed = new Set(options.methods.map((method) => `halo:${method}`));
    let origin = "";
    let started = false;
    let inflight = 0;
    // A random per-bridge cookie name, not a fixed "halo_renderer": cookies are
    // host-scoped and ignore the port, so two windows on 127.0.0.1 would otherwise
    // share one name and every bridge would receive the other windows' tokens.
    const cookieName = `halo_renderer_${crypto.randomBytes(8).toString("hex")}`;
    const timingSafeEqual = (a, b) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); };
    const authenticated = (req) => {
        for (const part of (req.headers.cookie ?? "").split(/;\s*/)) {
            const eq = part.indexOf("=");
            if (eq > 0 && part.slice(0, eq) === cookieName && timingSafeEqual(part.slice(eq + 1), cookieToken))
                return true;
        }
        return false;
    };
    const server = http.createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent)
        res.writeHead(500); res.end(); }); });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    const script = () => `"use strict";
(() => {
  const capability = ${JSON.stringify(capability)};
  const listeners = new Map();
  const api = { runtime: 'chromium', surfaceMode: ${JSON.stringify(options.remoteSurfaces ? "remote" : "native")}, layout: Object.freeze(${JSON.stringify(options.layout)}) };
  async function invoke(channel, args) {
    const response = await fetch('/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-halo-capability': capability }, body: JSON.stringify({ channel, args }) });
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
    async function handle(req, res) {
        const remote = req.socket.remoteAddress;
        if (!origin || !["127.0.0.1", "::ffff:127.0.0.1"].includes(remote ?? "") || req.headers.host !== new URL(origin).host) {
            res.writeHead(403);
            res.end();
            return;
        }
        const url = new URL(req.url ?? "/", origin);
        const immutableAsset = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2|svg)$/.test(url.pathname);
        // Vite emits content-hashed assets, so caching these across reloads is safe:
        // a changed build gets a new URL. HTML and the per-window bridge carry live
        // capabilities and must never be reused from cache.
        res.setHeader("Cache-Control", immutableAsset ? "public, max-age=31536000, immutable" : "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        if (req.method === "GET" && url.pathname === `/bootstrap/${cookieToken}`) {
            res.setHeader("Set-Cookie", `${cookieName}=${cookieToken}; HttpOnly; SameSite=Strict; Path=/`);
            res.writeHead(303, { Location: "/" });
            res.end();
            return;
        }
        if (!authenticated(req) || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin" && req.headers["sec-fetch-site"] !== "none")) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (url.pathname === "/rpc" && req.method === "POST") {
            const presented = req.headers["x-halo-capability"];
            if (req.headers.origin !== origin || typeof presented !== "string" || !timingSafeEqual(presented, capability) || req.headers["content-type"] !== "application/json") {
                res.writeHead(403);
                res.end();
                return;
            }
            if (inflight >= 16) {
                res.writeHead(429);
                res.end();
                return;
            }
            inflight += 1;
            try {
                const parts = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > MAX_BODY) {
                        res.writeHead(413);
                        res.end();
                        return;
                    }
                    parts.push(Buffer.from(chunk));
                }
                let body;
                try {
                    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
                }
                catch {
                    res.writeHead(400);
                    res.end();
                    return;
                }
                if (!body || typeof body.channel !== "string" || (!allowed.has(body.channel) && body.channel !== "halo:windowBounds") || !Array.isArray(body.args)) {
                    res.writeHead(400);
                    res.end();
                    return;
                }
                res.setHeader("Content-Type", "application/json");
                try {
                    const result = await options.invoke(body.channel, body.args);
                    res.end(JSON.stringify({ result: result ?? null }));
                }
                catch (error) {
                    const e = error;
                    res.end(JSON.stringify({ error: { code: e.code ?? "host_error", message: e.message ?? "Host request failed" } }));
                }
            }
            finally {
                inflight -= 1;
            }
            return;
        }
        if (req.method !== "GET") {
            res.writeHead(405);
            res.end();
            return;
        }
        if (url.pathname === "/events") {
            if (subscribers.size >= 4) {
                res.writeHead(429);
                res.end();
                return;
            }
            res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
            res.write(": ready\n\n");
            subscribers.add(res);
            req.once("close", () => subscribers.delete(res));
            return;
        }
        if (url.pathname === "/halo-bridge.js") {
            res.writeHead(200, { "Content-Type": "text/javascript" });
            res.end(script());
            return;
        }
        let relative;
        try {
            relative = decodeURIComponent(url.pathname);
        }
        catch {
            res.writeHead(400);
            res.end();
            return;
        }
        const root = await fs.realpath(options.root);
        const target = path.resolve(root, `.${relative === "/" ? "/index.html" : relative}`);
        if (!target.startsWith(`${root}${path.sep}`)) {
            res.writeHead(404);
            res.end();
            return;
        }
        try {
            if ((await fs.realpath(target)) !== target || !(await fs.stat(target)).isFile()) {
                res.writeHead(404);
                res.end();
                return;
            }
            const ext = path.extname(target);
            if (!MIME[ext]) {
                res.writeHead(404);
                res.end();
                return;
            }
            let bytes = await fs.readFile(target);
            // The Electron build ships a meta CSP (connect-src 'none') that would block /rpc and /events; the response header above is this origin's policy.
            if (ext === ".html")
                bytes = Buffer.from(bytes.toString("utf8").replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, "").replace("<head>", '<head><script src="/halo-bridge.js"></script>'));
            res.writeHead(200, { "Content-Type": MIME[ext] });
            res.end(bytes);
        }
        catch {
            res.writeHead(404);
            res.end();
        }
    }
    return {
        async start() {
            if (!started) {
                await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
                started = true;
            }
            origin = `http://127.0.0.1:${server.address().port}`;
            return { origin, url: `${origin}/bootstrap/${cookieToken}` };
        },
        send(channel, payload) {
            if (!Object.values(EVENTS).includes(channel))
                return;
            const bytes = `data: ${JSON.stringify({ channel, payload })}\n\n`;
            for (const res of subscribers) {
                if (res.writableLength > 1_048_576) {
                    res.destroy();
                    subscribers.delete(res);
                }
                else
                    res.write(bytes);
            }
        },
        async close() {
            for (const res of subscribers)
                res.end();
            subscribers.clear();
            if (started) {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(() => resolve()));
                started = false;
            }
        },
    };
}
module.exports = { createRendererBridge };
