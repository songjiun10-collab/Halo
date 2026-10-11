// Generated from runtime-src/main/harness/renderer-lifecycle.ts. Do not edit; run npm run build:runtime.
"use strict";
// Renderer lifecycle for agent surfaces: agent count != live renderer count.
//
// A ParkableView stands in for the view an agent's BrowserAdapter drives. The
// adapter keeps one stable `webContents` (an event emitter that forwards the
// live renderer's events), while the real renderer behind it moves between
//   ACTIVE    renderer alive and running
//   FROZEN    renderer alive, page lifecycle frozen (no JS/timers); thawed on use
//   DISCARDED renderer gone; URL and title kept, restored by one GET on next use
// The session (cookies, storage) lives in the partition, so it outlives a
// renderer. Restoring never replays input, form posts or downloads: it loads the
// saved URL, which fires did-navigate on the stable webContents, and the adapter
// already treats that as a new document (epoch bump, observation and approval
// bindings dropped), so nothing observed before a park can be acted on after it.
const events = require("node:events");
const os = require("node:os");
const FORWARDED_EVENTS = ["did-navigate", "did-navigate-in-page", "did-stop-loading", "did-fail-load", "page-title-updated", "will-navigate", "will-redirect"];
let nextProxyId = 1;
class SurfaceError extends Error {
    code;
    constructor(code, message) { super(`${code}: ${message}`); this.name = "SurfaceError"; this.code = code; }
}
function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
    }
    catch {
        return false;
    }
}
class ParkableView {
    webContents;
    state = "active";
    lastUsedAt;
    inner;
    opts;
    now;
    savedUrl = "about:blank";
    savedTitle = "";
    session = undefined;
    inflight = 0;
    restoring = null;
    closed = false;
    freezeBroken = false;
    unhook = [];
    // A live mirror of the page: it survives a discard/restore by re-attaching to the new renderer.
    screencast = null;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.lastUsedAt = this.now();
        this.inner = opts.lazy ? null : opts.create();
        if (opts.lazy)
            this.state = "discarded";
        this.session = opts.getSession ? safeCall(opts.getSession, undefined) : undefined;
        this.webContents = this.buildProxy();
        if (this.inner)
            this.hook(this.inner);
    }
    // ---- view surface used by BrowserAdapter / AgentViewportHost
    getBounds() { return { x: 0, y: 0, width: this.opts.width ?? 1280, height: this.opts.height ?? 800 }; }
    setBounds(bounds) { this.inner?.view.setBounds?.(bounds); }
    setVisible(visible) { this.inner?.view.setVisible?.(visible); }
    isLive() { return this.state === "active" && !!this.inner && !this.closed; }
    holdsRenderer() { return this.state !== "discarded" && !!this.inner && !this.closed; }
    isBusy() { return this.inflight > 0 || this.restoring !== null; }
    idleMs() { return this.now() - this.lastUsedAt; }
    // ---- lifecycle transitions (driven by SurfacePool, safe to call any time)
    async freeze() {
        if (this.state !== "active" || !this.inner || this.isBusy() || this.freezeBroken || this.closed)
            return false;
        try {
            await this.lifecycleCommand("frozen");
            if (this.isBusy() || this.state !== "active") {
                await this.lifecycleCommand("active").catch(() => undefined);
                return false;
            }
            this.state = "frozen";
            return true;
        }
        catch {
            this.freezeBroken = true;
            return false;
        }
    }
    async discard() {
        if (this.state === "discarded" || !this.inner || this.isBusy() || this.closed)
            return false;
        const inner = this.inner;
        const wc = inner.view.webContents;
        const url = safeCall(() => wc.getURL(), "");
        this.savedUrl = isHttpUrl(url) ? url : "about:blank";
        this.savedTitle = safeCall(() => wc.getTitle(), "");
        this.session ??= safeCall(() => wc.session, undefined);
        this.state = "discarded";
        this.inner = null;
        this.release(inner);
        return true;
    }
    // Restores or thaws the surface and resolves once it is ready; a no-op when it is live.
    wake() { return this.use(true, () => undefined); }
    // Brings a discarded or frozen surface back before a call runs against it.
    async ensureLive(loadSaved) {
        if (this.closed)
            throw new SurfaceError("surface_closed", "the agent surface was closed");
        if (this.state === "discarded") {
            if (!this.restoring) {
                this.restoring = (async () => {
                    const inner = this.opts.create();
                    this.inner = inner;
                    this.hook(inner);
                    this.state = "active";
                    if (loadSaved && this.savedUrl !== "about:blank")
                        await inner.view.webContents.loadURL(this.savedUrl);
                })().finally(() => { this.restoring = null; });
            }
            await this.restoring;
        }
        else if (this.state === "frozen") {
            await this.lifecycleCommand("active");
            this.state = "active";
        }
        // Startup/hardening is not navigation. Do not spend the adapter's action
        // deadline waiting for the initial CDP page to become ready.
        await this.inner?.view.webContents.ready;
        if (this.closed)
            throw new SurfaceError("surface_closed", "the agent surface was closed");
    }
    async purgeMemory() {
        if (!this.inner || this.closed)
            return;
        const wc = this.inner.view.webContents;
        if (typeof wc.purgeMemory === "function") {
            await wc.purgeMemory().catch(() => undefined);
            return;
        }
        const dbg = wc.debugger;
        if (dbg && dbg.isAttached?.()) {
            await dbg.sendCommand("Memory.forciblyPurgeJavaScriptMemory").catch(() => undefined);
        }
    }
    async lifecycleCommand(state) {
        const wc = this.inner?.view.webContents;
        if (!wc)
            return;
        if (typeof wc.rawCmd === "function") {
            await wc.rawCmd("Page.setWebLifecycleState", { state });
            if (state === "frozen")
                await wc.rawCmd("Memory.forciblyPurgeJavaScriptMemory").catch(() => undefined);
            return;
        }
        const dbg = wc.debugger;
        if (!dbg)
            throw new SurfaceError("freeze_unsupported", "no debugger channel");
        if (!dbg.isAttached())
            dbg.attach("1.3");
        await dbg.sendCommand("Page.setWebLifecycleState", { state });
        if (state === "frozen")
            await dbg.sendCommand("Memory.forciblyPurgeJavaScriptMemory").catch(() => undefined);
    }
    hook(inner) {
        const wc = inner.view.webContents;
        for (const name of FORWARDED_EVENTS) {
            const forward = (...args) => { if (this.inner === inner)
                this.webContents.emit(name, ...args); };
            wc.on(name, forward);
            this.unhook.push(() => wc.removeListener?.(name, forward));
        }
        this.session ??= safeCall(() => wc.session, undefined);
        if (this.screencast && typeof wc.startScreencast === "function") {
            const { options, onFrame } = this.screencast;
            void Promise.resolve(safeCall(() => wc.startScreencast(options, onFrame), undefined)).catch(() => undefined);
        }
    }
    release(inner) {
        for (const off of this.unhook.splice(0))
            safeCall(off, undefined);
        try {
            inner.view.webContents.close?.();
        }
        catch { /* already gone */ }
        try {
            inner.dispose();
        }
        catch { /* best effort */ }
    }
    async use(loadSaved, fn) {
        this.lastUsedAt = this.now();
        this.inflight += 1;
        try {
            await this.ensureLive(loadSaved);
            this.lastUsedAt = this.now();
            return await fn(this.inner.view.webContents);
        }
        finally {
            this.inflight -= 1;
            this.lastUsedAt = this.now();
        }
    }
    requireLive() {
        if (this.closed || !this.inner)
            throw new SurfaceError("surface_parked", "the agent surface has no live renderer");
        if (this.state !== "active")
            throw new SurfaceError("surface_frozen", "the agent surface is frozen");
        this.lastUsedAt = this.now();
        return this.inner.view.webContents;
    }
    buildProxy() {
        const self = this;
        const proxy = new events.EventEmitter();
        proxy.setMaxListeners(0);
        proxy.id = 1_000_000 + nextProxyId++;
        proxy.getURL = () => (self.inner ? safeCall(() => self.inner.view.webContents.getURL(), self.savedUrl) : self.savedUrl);
        proxy.getTitle = () => (self.inner ? safeCall(() => self.inner.view.webContents.getTitle(), self.savedTitle) : self.savedTitle);
        proxy.isDestroyed = () => self.closed;
        Object.defineProperty(proxy, "session", { get: () => self.session });
        Object.defineProperty(proxy, "captureJpeg", {
            get: () => typeof self.inner?.view.webContents.captureJpeg === "function"
                ? (...args) => self.use(true, (wc) => wc.captureJpeg(...args))
                : undefined,
        });
        Object.defineProperty(proxy, "startScreencast", {
            get: () => typeof self.inner?.view.webContents.startScreencast === "function"
                ? async (options, onFrame) => {
                    self.screencast = { options, onFrame };
                    try {
                        await self.use(true, (wc) => wc.startScreencast(options, onFrame));
                    }
                    catch (error) {
                        self.screencast = null;
                        throw error;
                    }
                }
                : undefined,
        });
        Object.defineProperty(proxy, "stopScreencast", {
            get: () => typeof self.inner?.view.webContents.stopScreencast === "function"
                ? async () => { self.screencast = null; await self.inner?.view.webContents.stopScreencast?.(); }
                : undefined,
        });
        Object.defineProperty(proxy, "navigationHistory", {
            get: () => self.inner?.view.webContents.navigationHistory ?? { canGoBack: () => false, canGoForward: () => false, getActiveIndex: () => 0, length: () => 1 },
        });
        // Navigation replaces the page, so a discarded surface needs no restore first.
        proxy.loadURL = (url, options) => self.use(false, (wc) => wc.loadURL(url, options));
        for (const method of ["executeJavaScript", "executeJavaScriptInIsolatedWorld", "capturePage", "stop"]) {
            proxy[method] = (...args) => self.use(true, (wc) => wc[method](...args));
        }
        // Synchronous input never wakes a surface; it fails closed instead.
        for (const method of ["sendInputEvent", "insertText", "selectAll"]) {
            proxy[method] = (...args) => self.requireLive()[method](...args);
        }
        proxy.close = () => self.shutdown();
        proxy.destroy = () => self.shutdown();
        return proxy;
    }
    shutdown() {
        if (this.closed)
            return;
        this.closed = true;
        this.screencast = null;
        const inner = this.inner;
        this.inner = null;
        this.state = "discarded";
        if (inner)
            this.release(inner);
        this.webContents.emit("destroyed");
    }
}
// A restore fires did-navigate, which the adapter rightly treats as a page change
// during an observation in flight. So the surface is woken *before* these calls begin.
const WAKE_METHODS = ["observe", "execute", "captureScreenshot", "captureScreenGeometry"];
function wakeOnUse(adapter, view) {
    for (const name of WAKE_METHODS) {
        const original = adapter[name];
        if (typeof original !== "function")
            continue;
        adapter[name] = async (...args) => { await view.wake(); return original.apply(adapter, args); };
    }
    return adapter;
}
function safeCall(fn, fallback) { try {
    return fn();
}
catch {
    return fallback;
} }
const DEFAULT_POLICY = Object.freeze({ maxActive: "auto", perSurfaceMb: 125, reserveMb: 1_024, minActive: 2, freezeAfterMs: 8_000, discardAfterMs: 120_000, minIdleMs: 3_000, idleShutdownMs: 30_000 });
// macOS reports little "free" memory because it caches aggressively; treat a quarter of RAM as always reclaimable.
function defaultFreeMemoryMb() {
    return Math.max(os.freemem(), os.totalmem() * 0.25) / (1024 * 1024);
}
class SurfacePool {
    surfaces = new Map();
    pins = new Map();
    policy;
    timer = null;
    onIdle;
    now;
    idleSince = null;
    freeMemoryMb;
    constructor(policy = {}, hooks = {}) {
        this.policy = { ...DEFAULT_POLICY, ...policy };
        this.onIdle = hooks.onIdle ?? null;
        this.now = hooks.now ?? Date.now;
        this.freeMemoryMb = hooks.freeMemoryMb ?? defaultFreeMemoryMb;
    }
    // The live-renderer budget. A fixed number, or (auto) what free memory affords,
    // floored at minActive so a memory spike can never discard every surface.
    effectiveMaxActive() {
        const { maxActive, perSurfaceMb, reserveMb, minActive } = this.policy;
        if (maxActive !== "auto")
            return maxActive;
        return Math.max(minActive, Math.floor((this.freeMemoryMb() - reserveMb) / perSurfaceMb));
    }
    register(id, view) { this.surfaces.set(id, view); }
    unregister(id) { this.surfaces.delete(id); this.pins.delete(id); }
    // A pinned surface is never frozen or discarded (e.g. a page the user is looking at).
    pin(id) { this.pins.set(id, (this.pins.get(id) ?? 0) + 1); }
    unpin(id) { const n = (this.pins.get(id) ?? 0) - 1; if (n > 0)
        this.pins.set(id, n);
    else
        this.pins.delete(id); }
    counts() {
        const out = { active: 0, frozen: 0, discarded: 0 };
        for (const view of this.surfaces.values())
            out[view.state] += 1;
        return out;
    }
    candidates() {
        return [...this.surfaces].filter(([id, view]) => !this.pins.has(id) && !view.isBusy());
    }
    // One pass of the policy. Safe to call at any time and from any number of places.
    async sweep() {
        const { freezeAfterMs, discardAfterMs, minIdleMs } = this.policy;
        const maxActive = this.effectiveMaxActive();
        const idle = this.candidates().sort((a, b) => b[1].idleMs() - a[1].idleMs());
        for (const [, view] of idle) {
            if (view.idleMs() >= discardAfterMs)
                await view.discard();
            else if (view.idleMs() >= freezeAfterMs && view.state === "active")
                await view.freeze();
        }
        let live = [...this.surfaces.values()].filter((v) => v.state !== "discarded").length;
        for (const [, view] of this.candidates().sort((a, b) => b[1].idleMs() - a[1].idleMs())) {
            if (live <= maxActive)
                break;
            if (view.state !== "discarded" && view.idleMs() >= minIdleMs && (await view.discard()))
                live -= 1;
        }
        await this.checkIdle();
    }
    // Nothing alive, busy or pinned for idleShutdownMs: tell the owner the browser process can go.
    // Fires once per idle stretch; the next live surface re-arms it.
    async checkIdle() {
        if (!this.onIdle || this.policy.idleShutdownMs <= 0)
            return;
        const inUse = this.pins.size > 0 || [...this.surfaces.values()].some((v) => v.isBusy() || v.holdsRenderer());
        if (inUse) {
            this.idleSince = null;
            return;
        }
        const now = this.now();
        if (this.idleSince === null) {
            this.idleSince = now;
            return;
        }
        if (now - this.idleSince < this.policy.idleShutdownMs)
            return;
        this.idleSince = Number.POSITIVE_INFINITY;
        await Promise.resolve(this.onIdle()).catch(() => undefined);
    }
    // Memory pressure: "soft" freezes everything idle and purges memory, "hard" discards idle surfaces, oldest first.
    async relieve(level, minIdleMs = this.policy.minIdleMs) {
        let changed = 0;
        for (const [, view] of this.candidates().filter(([, v]) => v.idleMs() >= minIdleMs).sort((a, b) => b[1].idleMs() - a[1].idleMs())) {
            if (level === "hard") {
                if (await view.discard())
                    changed += 1;
            }
            else {
                if (view.state === "active") {
                    if (await view.freeze())
                        changed += 1;
                }
                else if (view.state === "frozen") {
                    await view.purgeMemory();
                    changed += 1;
                }
            }
        }
        return changed;
    }
    start(intervalMs = 2_000) {
        if (this.timer)
            return;
        this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, intervalMs);
        this.timer.unref?.();
    }
    stop() { if (this.timer)
        clearInterval(this.timer); this.timer = null; }
}
module.exports = { ParkableView, SurfacePool, SurfaceError, DEFAULT_POLICY, wakeOnUse };
