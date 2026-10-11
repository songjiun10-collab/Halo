// Generated from runtime-src/main/harness/cdp-web-contents.ts. Do not edit; run npm run build:runtime.
"use strict";
// Same ad/tracker list the Electron agent session uses, so both engines refuse the same hosts.
const { isBlockedUrl } = require("./agent-request-filter");
// Chromium has no "deny everything" switch: the CDP path must name each permission,
// unlike the Electron path's setPermissionRequestHandler(callback(false)) default-deny.
// Unknown names are ignored by the `.catch`, so this is kept a superset of the
// device/privacy permissions an agent page must never hold (the Electron typings'
// full permission list is the reference). Deny-by-name remains best-effort: any
// permission Chromium adds after this list is not covered here.
const DENIED_PERMISSIONS = ["geolocation", "notifications", "camera", "microphone", "midi", "clipboard-read", "clipboard-write", "screen-wake-lock", "persistent-storage", "background-sync", "idle-detection", "window-management", "local-fonts", "display-capture", "usb", "serial", "hid", "bluetooth", "nfc", "file-system-access", "accessibility-events", "storage-access", "top-level-storage-access", "periodic-background-sync", "payment-handler", "smart-card", "speaker-selection", "captured-surface-control", "protected-media-identifier", "keyboard-lock", "pointer-lock", "vr", "ar", "hand-tracking", "ambient-light-sensor", "accelerometer", "gyroscope", "magnetometer"];
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const COMMAND_TIMEOUT_MS = 30000;
const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
const KEYS = {
    Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", vk: 9 },
    Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
    Delete: { key: "Delete", code: "Delete", vk: 46 },
    Escape: { key: "Escape", code: "Escape", vk: 27 },
    Space: { key: " ", code: "Space", vk: 32, text: " " },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    Home: { key: "Home", code: "Home", vk: 36 },
    End: { key: "End", code: "End", vk: 35 },
    PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
    PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
};
function modifierMask(modifiers) {
    if (!Array.isArray(modifiers))
        return 0;
    return modifiers.reduce((mask, name) => mask | (MODIFIER_BITS[String(name).toLowerCase()] ?? 0), 0);
}
function keyInfo(keyCode) {
    const known = KEYS[keyCode];
    if (known)
        return known;
    if (keyCode.length === 1) {
        const upper = keyCode.toUpperCase();
        const code = /[a-z]/i.test(keyCode) ? `Key${upper}` : /[0-9]/.test(keyCode) ? `Digit${keyCode}` : "";
        return { key: keyCode, code, vk: upper.charCodeAt(0), text: keyCode };
    }
    return { key: keyCode, code: keyCode, vk: 0 };
}
function pngSize(png) {
    // IHDR width/height are big-endian uint32 at bytes 16 and 20.
    if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG")
        return { width: 0, height: 0 };
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
// Web Bot Auth headers a signer may have added on an earlier interception are
// replaced, never accumulated; Fetch.continueRequest sends back the full set.
const SIGNATURE_REQUEST_HEADERS = new Set(["signature", "signature-agent", "signature-input"]);
// Fetch.continueRequest overrides the request header set, so the full set must
// be sent back: every existing header (minus stale signature headers) plus the
// new ones. Cookies are attached by the network stack after interception, so
// the jar is unaffected.
function mergeRequestHeaders(existing, extra) {
    const merged = [];
    const seen = new Set();
    const push = (name, value) => {
        const normalized = String(name ?? "");
        const lower = normalized.toLowerCase();
        if (normalized.length === 0 || seen.has(lower) || SIGNATURE_REQUEST_HEADERS.has(lower))
            return;
        seen.add(lower);
        merged.push({ name: normalized, value: String(value ?? "") });
    };
    if (Array.isArray(existing))
        for (const entry of existing)
            push(entry?.name, entry?.value);
    else if (existing && typeof existing === "object")
        for (const [name, value] of Object.entries(existing))
            push(name, value);
    for (const [name, value] of Object.entries(extra))
        merged.push({ name, value });
    return merged;
}
// One browser-level WebSocket multiplexing sessions (flatten:true).
function connectCdpTransport(browserWsUrl, commandTimeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const WS = globalThis.WebSocket;
        if (typeof WS !== "function") {
            reject(new Error("cdp_unsupported: global WebSocket is unavailable"));
            return;
        }
        const socket = new WS(browserWsUrl);
        let nextId = 1;
        let closed = false;
        const pending = new Map();
        const handlers = new Set();
        const failAll = (error) => {
            closed = true;
            for (const [, entry] of pending) {
                clearTimeout(entry.timer);
                entry.reject(error);
            }
            pending.clear();
            for (const handler of handlers)
                handler("Halo.transportClosed", {});
        };
        socket.addEventListener("message", (message) => {
            let parsed;
            try {
                parsed = JSON.parse(String(message.data));
            }
            catch {
                return;
            }
            if (typeof parsed.id === "number") {
                const entry = pending.get(parsed.id);
                if (!entry)
                    return;
                pending.delete(parsed.id);
                clearTimeout(entry.timer);
                if (parsed.error)
                    entry.reject(new Error(`cdp_error: ${parsed.error.message ?? "command failed"}`));
                else
                    entry.resolve(parsed.result ?? {});
            }
            else if (typeof parsed.method === "string") {
                for (const handler of [...handlers])
                    handler(parsed.method, parsed.params ?? {}, parsed.sessionId);
            }
        });
        socket.addEventListener("close", () => failAll(new Error("cdp_closed: connection closed")));
        socket.addEventListener("error", () => { if (!closed)
            reject(new Error("cdp_connect_failed: cannot reach the debugging endpoint")); });
        socket.addEventListener("open", () => resolve({
            send(method, params = {}, sessionId) {
                if (closed)
                    return Promise.reject(new Error("cdp_closed: connection closed"));
                const id = nextId++;
                return new Promise((res, rej) => {
                    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`cdp_timeout: ${method}`)); }, commandTimeoutMs);
                    pending.set(id, { resolve: res, reject: rej, timer });
                    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
                });
            },
            onEvent(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
            close() { if (!closed) {
                closed = true;
                try {
                    socket.close();
                }
                catch { /* already closing */ }
            } },
        }));
    });
}
// The few nativeImage methods the host reads. resize() is lazy: it re-captures at the target scale,
// so a small fingerprint or a 1200px JPEG never decodes the full-size bitmap in this process.
class CdpImage {
    png;
    size;
    encodeJpeg;
    targetWidth;
    constructor(png, size, encodeJpeg, targetWidth) {
        this.png = png;
        this.size = size;
        this.encodeJpeg = encodeJpeg;
        this.targetWidth = targetWidth;
    }
    isEmpty() { return this.size.width === 0 || this.size.height === 0; }
    getSize() {
        if (!this.targetWidth)
            return this.size;
        return { width: this.targetWidth, height: Math.max(1, Math.round(this.size.height * this.targetWidth / this.size.width)) };
    }
    toPNG() { return this.png; }
    resize(options) { return new CdpImage(this.png, this.size, this.encodeJpeg, options.width); }
    // A cheap change fingerprint: the PNG bytes themselves differ whenever pixels differ.
    toBitmap() { return this.png; }
    // Synchronous like nativeImage; the caller awaits the lazily encoded JPEG through encodeJpegAsync.
    toJPEG(_quality) { throw new Error("cdp_image: use encodeJpegAsync"); }
    encodeJpegAsync(quality) { return this.encodeJpeg(quality, this.targetWidth); }
}
let nextWebContentsId = 1;
class CdpWebContents {
    viewportWidth = DEFAULT_WIDTH;
    viewportHeight = DEFAULT_HEIGHT;
    viewportChange = Promise.resolve();
    // Fire-and-forget input is the renderer's synchronous contract, but its CDP
    // command must still settle before a following DOM read or screenshot. Keep
    // those commands ordered without making pointer/key dispatch block the UI.
    inputChain = Promise.resolve();
    webContentsId = nextWebContentsId++;
    listeners = new Map();
    unsubscribe;
    url = "about:blank";
    title = "";
    mainFrameId = "";
    // Loader id of the last main-frame navigation (initial frame tree or
    // Page.frameNavigated). navigate() uses it to correlate
    // Page.domContentEventFired with the navigation it is actually waiting for:
    // that event carries only a timestamp, and the root frame's
    // DOMContentLoaded is the readiness signal (subframes cannot produce it --
    // inspector_page_agent.cc's DomContentLoadedEventFired emits only for
    // inspected_frames_->Root()).
    mainFrameLoaderId = null;
    httpStatus = null;
    history = [];
    historyIndex = -1;
    // worldId -> live executionContextId for the isolated world this page created.
    worlds = new Map();
    // Bumped whenever a cached world is known to be gone, so the next
    // createIsolatedWorld asks for a name Chromium has no dead entry for. See
    // isolatedWorldName().
    worldIncarnation = 0;
    destroyed = false;
    sessionId = "";
    screencast = null;
    targetId = "";
    contextId = null;
    transport;
    options;
    provider;
    // Resolves once the page exists and is configured. Everything that talks to
    // the browser waits on it, so a caller can use the page right after construction.
    ready;
    isCdp = true;
    get session() { return this.options.session; }
    navigationHistory;
    // Synchronous on purpose: the harness builds a task's browser without awaiting.
    constructor(provider, options = {}) {
        this.provider = provider;
        this.options = options;
        this.unsubscribe = () => undefined;
        this.navigationHistory = {
            canGoBack: () => this.historyIndex > 0,
            canGoForward: () => this.historyIndex >= 0 && this.historyIndex < this.history.length - 1,
            getActiveIndex: () => this.historyIndex,
            goToIndex: (index) => {
                const entry = this.history[index];
                if (!entry)
                    throw new Error("cdp_history: no such entry");
                this.cmd("Page.navigateToHistoryEntry", { entryId: entry.id }).catch(() => this.emit("did-fail-load", {}, -1, "history", entry.url, true));
            },
        };
        this.ready = this.init();
        this.ready.catch(() => this.markDestroyed());
    }
    static async open(transport, options = {}) {
        const page = new CdpWebContents(async () => transport, options);
        await page.ready;
        return page;
    }
    async init() {
        const { url = "about:blank", width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, isolated = false, hardened = true } = this.options;
        const transport = await this.provider();
        this.transport = transport;
        // An isolated context has its own cookies and storage, like one Agent partition.
        // A shared context (one per Agent partition) outlives this page, like an Electron partition does.
        if (this.options.sharedContext)
            this.contextId = await this.options.sharedContext(transport);
        else if (isolated)
            this.contextId = (await transport.send("Target.createBrowserContext")).browserContextId;
        const scope = this.contextId ? { browserContextId: this.contextId } : {};
        this.unsubscribe = transport.onEvent((method, params, session) => this.onEvent(method, params, session));
        await transport.send("Target.setDiscoverTargets", { discover: true });
        const { targetId } = await transport.send("Target.createTarget", { url: "about:blank", ...scope });
        this.targetId = targetId;
        const { sessionId } = await transport.send("Target.attachToTarget", { targetId, flatten: true });
        this.sessionId = sessionId;
        if (hardened)
            await this.harden(scope);
        const [, , , tree] = await Promise.all([
            this.rawCmd("Page.enable"),
            this.rawCmd("Network.enable"),
            this.rawCmd("Runtime.enable"),
            this.rawCmd("Page.getFrameTree"),
            this.rawCmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: this.options.deviceScaleFactor ?? 1, mobile: false }),
            this.rawCmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }).catch(() => undefined),
            this.rawCmd("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined),
        ]);
        this.viewportWidth = width;
        this.viewportHeight = height;
        this.mainFrameId = tree?.frameTree?.frame?.id ?? "";
        this.mainFrameLoaderId = typeof tree?.frameTree?.frame?.loaderId === "string" ? tree.frameTree.frame.loaderId : null;
        await this.refreshHistory();
        if (url !== "about:blank")
            await this.navigate(url);
    }
    // The same fail-closed policy the Electron agent view gets: no permissions,
    // no downloads, no popups, only http(s) navigation, no ad/tracker subrequests.
    async harden(scope) {
        const browser = this.transport;
        await browser.send("Browser.setDownloadBehavior", { behavior: "deny", ...scope }).catch(() => undefined);
        await Promise.all(DENIED_PERMISSIONS.map((name) => browser.send("Browser.setPermission", { permission: { name }, setting: "denied", ...scope }).catch(() => undefined)));
        await this.rawCmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    }
    onRequestPaused(params) {
        const url = String(params.request?.url ?? "");
        const isDocument = params.resourceType === "Document";
        let allowed = true;
        try {
            const protocol = new URL(url).protocol;
            if (protocol !== "http:" && protocol !== "https:")
                allowed = protocol === "about:" || protocol === "blob:" || protocol === "data:" ? !isDocument || url === "about:blank" : false;
        }
        catch {
            allowed = false;
        }
        // Recreate Electron's synchronous navigation veto at Chromium's request
        // boundary. BrowserAdapter installs its assigned-origin and Intent Lock
        // listeners on these events; without this bridge, a page's own
        // location=..., meta refresh, or server redirect bypasses those checks.
        if (allowed && isDocument && params.frameId === this.mainFrameId) {
            let prevented = false;
            const event = { preventDefault() { prevented = true; } };
            this.emit(params.redirectedRequestId ? "will-redirect" : "will-navigate", event, url);
            if (prevented)
                allowed = false;
        }
        if (allowed && !isDocument && isBlockedUrl(url))
            allowed = false;
        if (allowed) {
            // Web Bot Auth: the host's signer adds identity headers on top of the
            // request's own headers. A signing failure must never block or delay the
            // request, so it falls back to an unsigned continue.
            let extra = null;
            try {
                extra = this.options.signRequestHeaders?.(url) ?? null;
            }
            catch {
                extra = null;
            }
            const continueParams = extra && Object.keys(extra).length > 0
                ? { requestId: params.requestId, headers: mergeRequestHeaders(params.request?.headers, extra) }
                : { requestId: params.requestId };
            this.rawCmd("Fetch.continueRequest", continueParams).catch(() => undefined);
            return;
        }
        this.rawCmd("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
    }
    isDestroyed() { return this.destroyed; }
    rawCmd(method, params = {}) {
        return this.transport.send(method, params, this.sessionId);
    }
    async cmd(method, params = {}) {
        await this.ready;
        return this.rawCmd(method, params);
    }
    emit(name, ...args) {
        for (const listener of [...(this.listeners.get(name) ?? [])]) {
            try {
                listener(...args);
            }
            catch { /* a listener must not break event delivery */ }
        }
    }
    async refreshHistory() {
        try {
            const result = await this.rawCmd("Page.getNavigationHistory");
            this.history = result.entries.map((entry) => ({ id: entry.id, url: entry.url }));
            this.historyIndex = result.currentIndex;
        }
        catch { /* page may be closing */ }
    }
    onEvent(method, params, session) {
        if (method === "Halo.transportClosed") {
            this.markDestroyed();
            return;
        }
        if (method === "Target.targetInfoChanged" && params.targetInfo?.targetId === this.targetId) {
            const next = String(params.targetInfo.title ?? "");
            if (next !== this.title) {
                this.title = next;
                this.emit("page-title-updated", {}, next);
            }
            return;
        }
        if (method === "Target.targetCreated" && params.targetInfo?.openerId === this.targetId && this.options.hardened !== false) {
            this.transport.send("Target.closeTarget", { targetId: params.targetInfo.targetId }).catch(() => undefined);
            return;
        }
        if (method === "Target.targetCrashed" && params.targetId === this.targetId) {
            // Electron parity: a crashed renderer reports render-process-gone before the page is gone.
            this.emit("render-process-gone", {}, { reason: "crashed" });
            this.markDestroyed();
            return;
        }
        if (method === "Target.detachedFromTarget" && params.sessionId === this.sessionId) {
            this.markDestroyed();
            return;
        }
        if (session !== this.sessionId)
            return;
        switch (method) {
            case "Fetch.requestPaused":
                this.onRequestPaused(params);
                break;
            case "Network.responseReceived":
                if (params.type === "Document" && params.frameId === this.mainFrameId)
                    this.httpStatus = Number.isInteger(params.response?.status) ? params.response.status : null;
                break;
            case "Page.frameNavigated":
                // A request vetoed at the Fetch boundary leaves Chromium on its error page;
                // Electron's synchronous veto never navigates, so the page keeps its URL.
                if (!params.frame?.parentId && !String(params.frame?.url ?? "").startsWith("chrome-error://")) {
                    this.url = params.frame.url;
                    this.mainFrameId = params.frame.id;
                    if (typeof params.frame.loaderId === "string" && params.frame.loaderId)
                        this.mainFrameLoaderId = params.frame.loaderId;
                    this.invalidateWorlds();
                    // Emit before the history refresh: Electron orders did-navigate before did-stop-loading,
                    // and the adapter's epoch must not move after a load has already been reported done.
                    this.emit("did-navigate", {}, this.url, this.httpStatus ?? 0, "");
                    void this.refreshHistory();
                }
                break;
            case "Page.navigatedWithinDocument":
                if (params.frameId === this.mainFrameId) {
                    this.url = params.url;
                    this.emit("did-navigate-in-page", {}, this.url, true);
                    void this.refreshHistory();
                }
                break;
            case "Page.frameStoppedLoading":
                if (params.frameId === this.mainFrameId) {
                    this.emit("did-stop-loading");
                    this.emit("did-finish-load");
                }
                break;
            case "Page.frameStartedLoading":
                if (params.frameId === this.mainFrameId)
                    this.emit("did-start-navigation", {}, this.url, false, true);
                break;
            case "Page.domContentEventFired":
                this.emit("dom-ready");
                break;
            // A lifecycle freeze (Page.setWebLifecycleState "frozen", plus the
            // Memory.forciblyPurgeJavaScriptMemory that freeze() sends with it) destroys
            // each context with its own event and never emits
            // Runtime.executionContextsCleared, so a world cached before the freeze
            // would otherwise survive as a dead id. The map is keyed by worldId and
            // holds contextIds as its values, so the check is over the values.
            case "Runtime.executionContextDestroyed": {
                const destroyed = params.executionContextId;
                for (const cached of this.worlds.values()) {
                    if (cached === destroyed) {
                        this.invalidateWorlds();
                        break;
                    }
                }
                break;
            }
            case "Runtime.executionContextsCleared":
                this.invalidateWorlds();
                break;
            case "Page.screencastFrame": {
                // Ack first so Chromium keeps producing frames; the listener only ever sees the newest bytes.
                this.rawCmd("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
                if (this.screencast && typeof params.data === "string") {
                    try {
                        this.screencast(params.data);
                    }
                    catch { /* a listener must not stop frames */ }
                }
                break;
            }
            default:
                break;
        }
    }
    markDestroyed() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.unsubscribe();
        this.emit("destroyed");
    }
    on(name, listener) {
        const set = this.listeners.get(name) ?? new Set();
        set.add(listener);
        this.listeners.set(name, set);
        return this;
    }
    removeListener(name, listener) {
        this.listeners.get(name)?.delete(listener);
        return this;
    }
    once(name, listener) {
        const wrapped = (...args) => { this.removeListener(name, wrapped); listener(...args); };
        return this.on(name, wrapped);
    }
    setWindowOpenHandler(_handler) { }
    async setViewportSize(width, height) {
        if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 16384))
            return Promise.reject(new Error("invalid_viewport"));
        const update = this.viewportChange.catch(() => undefined).then(async () => {
            await this.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: this.options.deviceScaleFactor ?? 1, mobile: false });
            this.viewportWidth = width;
            this.viewportHeight = height;
        });
        this.viewportChange = update;
        return update;
    }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    get id() { return this.webContentsId; }
    async loadURL(url) {
        await this.ready;
        return this.navigate(url);
    }
    // Resolves when the new document is readable, not when every subresource has
    // finished. The first trustworthy signal wins:
    //   - Page.domContentEventFired for THIS navigation's loader id (root frame
    //     only; correlated by mainFrameLoaderId so a previous page's late DCL
    //     cannot resolve us), or
    //   - Page.frameStoppedLoading, but only once this navigation has started
    //     (frameStartedLoading) or committed (frameNavigated): the previous
    //     page's trailing did-stop-loading can arrive after the next navigate()
    //     call has already begun waiting, and resolving on it would hand back a
    //     document that has not even committed yet (observed as stale_document
    //     in the readiness probe), or
    //   - page destruction.
    // Measured on real pages (2026-10-09): DCL arrives 40ms-1.5s before full load
    // and observe() already works at DCL, so this is the per-navigation wait the
    // browser-use-speed work targets. The adapter's timeout still bounds the
    // whole wait; a navigation with no loaderId (same-document) keeps the old
    // stop-based wait, and a download resolves without waiting for a document.
    async navigate(url) {
        if (this.destroyed)
            throw new Error("cdp_destroyed: page is closed");
        let expectedLoaderId = null;
        let navStarted = false;
        let navCommitted = false;
        let done = () => { };
        const ready = new Promise((resolve) => {
            let settled = false;
            done = () => {
                if (settled)
                    return;
                settled = true;
                this.removeListener("did-start-navigation", onStart);
                this.removeListener("did-navigate", onCommitted);
                this.removeListener("dom-ready", onDomReady);
                this.removeListener("did-stop-loading", onStopped);
                this.removeListener("destroyed", onDestroyed);
                resolve();
            };
            const onStart = () => { if (expectedLoaderId !== null)
                navStarted = true; };
            const onCommitted = () => { if (expectedLoaderId !== null && this.mainFrameLoaderId === expectedLoaderId)
                navCommitted = true; };
            const onDomReady = () => { if (expectedLoaderId !== null && this.mainFrameLoaderId === expectedLoaderId)
                done(); };
            const onStopped = () => { if (navCommitted || navStarted)
                done(); };
            const onDestroyed = () => done();
            this.on("did-start-navigation", onStart);
            this.on("did-navigate", onCommitted);
            this.on("dom-ready", onDomReady);
            this.on("did-stop-loading", onStopped);
            this.on("destroyed", onDestroyed);
        });
        try {
            const result = await this.rawCmd("Page.navigate", { url });
            if (result.errorText) {
                this.emit("did-fail-load", {}, -1, String(result.errorText), url, true);
                throw new Error(`navigation_error: ${result.errorText}`);
            }
            if (result.isDownload) {
                done();
                return;
            }
            if (result.loaderId) {
                expectedLoaderId = String(result.loaderId);
                await ready;
            }
            else {
                done();
            }
        }
        catch (error) {
            done();
            throw error;
        }
    }
    stop() { this.cmd("Page.stopLoading").catch(() => undefined); }
    async executeJavaScript(code) {
        return this.evaluate(code);
    }
    // The world name must be unique per incarnation. Chromium keys created worlds
    // by name for the life of the frame: after a lifecycle freeze destroys the
    // context, re-creating the SAME name returns the dead contextId forever
    // (verified against a real out/Trial Chromium -- see the freeze regression in
    // test/renderer-lifecycle.test.js). A fresh suffix is what actually produces a
    // live world again.
    isolatedWorldName(worldId) {
        return `halo-${worldId}-${this.worldIncarnation}`;
    }
    // Drops the cached world and forces the next call to build a new one. Used when
    // Chromium reports the context is gone, which a plain cache clear cannot undo.
    invalidateWorlds() {
        this.worlds.clear();
        this.worldIncarnation += 1;
    }
    async createWorldContext(worldId) {
        const created = await this.cmd("Page.createIsolatedWorld", { frameId: this.mainFrameId, worldName: this.isolatedWorldName(worldId), grantUniveralAccess: false });
        const contextId = created.executionContextId;
        this.worlds.set(worldId, contextId);
        return contextId;
    }
    // Chromium answers Runtime.evaluate on a dead context with this message. It
    // means the cached world is gone, never that the page script failed, so the
    // only correct response is to rebuild the world and run the script once more.
    // The cdp_error: prefix is required so a page script that happens to throw the
    // same text (script_error: ...) is not mistaken for a dead world.
    static isMissingContext(error) {
        const message = error instanceof Error ? error.message : String(error);
        return message.startsWith("cdp_error:") && message.includes("Cannot find context with specified id");
    }
    async executeJavaScriptInIsolatedWorld(worldId, scripts, _userGesture) {
        const contextId = this.worlds.get(worldId) ?? await this.createWorldContext(worldId);
        let value;
        try {
            for (const script of scripts)
                value = await this.evaluate(script.code, contextId);
        }
        catch (error) {
            if (!CdpWebContents.isMissingContext(error))
                throw error;
            this.invalidateWorlds();
            const recreated = await this.createWorldContext(worldId);
            for (const script of scripts)
                value = await this.evaluate(script.code, recreated);
        }
        return value;
    }
    async evaluate(expression, contextId) {
        await this.inputChain;
        const result = await this.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...(contextId === undefined ? {} : { contextId }) });
        if (result.exceptionDetails)
            throw new Error(`script_error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed"}`);
        return result.result?.value;
    }
    sendInputEvent(event) {
        const modifiers = modifierMask(event.modifiers);
        const enqueue = (method, params) => {
            this.inputChain = this.inputChain.then(() => this.cmd(method, params)).then(() => undefined).catch(() => undefined);
        };
        switch (event.type) {
            case "mouseMove":
                enqueue("Input.dispatchMouseEvent", { type: "mouseMoved", x: event.x, y: event.y, modifiers });
                break;
            case "mouseDown":
            case "mouseUp":
                enqueue("Input.dispatchMouseEvent", {
                    type: event.type === "mouseDown" ? "mousePressed" : "mouseReleased", x: event.x, y: event.y, modifiers,
                    button: event.button ?? "left", clickCount: event.clickCount ?? 1,
                });
                break;
            case "mouseWheel":
                // This WebContents-compatible entry point receives Electron wheel signs.
                // CDP uses DOM signs (positive = right/down), the opposite convention.
                enqueue("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: -(event.deltaX ?? 0), deltaY: -(event.deltaY ?? 0), modifiers });
                break;
            case "keyDown":
            case "keyUp": {
                const info = keyInfo(String(event.keyCode));
                enqueue("Input.dispatchKeyEvent", {
                    type: event.type === "keyDown" ? "rawKeyDown" : "keyUp", key: info.key, code: info.code,
                    windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers,
                });
                break;
            }
            case "char": {
                const info = keyInfo(String(event.keyCode));
                const text = info.text ?? info.key;
                enqueue("Input.dispatchKeyEvent", { type: "char", key: info.key, code: info.code, text, unmodifiedText: text, modifiers });
                break;
            }
            default:
                break;
        }
    }
    insertText(text) {
        this.inputChain = this.inputChain.then(() => this.cmd("Input.insertText", { text })).then(() => undefined).catch(() => undefined);
    }
    selectAll() {
        this.cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIER_BITS.meta, commands: ["selectAll"] })
            .then(() => this.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIER_BITS.meta }))
            .catch(() => undefined);
    }
    // density > 1 renders the still at that multiple of the page's own pixel density (a 1x agent page captured sharp).
    async captureJpeg({ maxWidth, quality, density = 1 }) {
        if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 8192 || !Number.isInteger(quality) || quality < 1 || quality > 100 || !(density >= 1 && density <= 4))
            throw new Error("invalid_capture_options");
        await this.ready;
        await this.viewportChange;
        const width = this.viewportWidth, height = this.viewportHeight;
        const shot = await this.cmd("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false,
            clip: { x: 0, y: 0, width, height, scale: Math.min(density, maxWidth / width) } });
        return Buffer.from(String(shot.data), "base64");
    }
    // Push-based live view: Chromium sends a JPEG only when the page paints something new.
    async startScreencast({ maxWidth, quality }, onFrame) {
        if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 8192 || !Number.isInteger(quality) || quality < 1 || quality > 100)
            throw new Error("invalid_capture_options");
        await this.ready;
        await this.viewportChange;
        this.screencast = onFrame;
        // Agent mirrors are for progress visibility, not remote desktop control.
        // Keep Chromium's initial-frame behavior intact; throttle at the consumer
        // if mirror traffic needs further tuning.
        await this.cmd("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight: Math.min(8192, Math.round(maxWidth * 2)) });
    }
    async stopScreencast() {
        this.screencast = null;
        if (this.destroyed)
            return;
        await this.cmd("Page.stopScreencast").catch(() => undefined);
    }
    // rect defines WHAT to capture (logical viewport pixels); options.scale
    // renders it smaller at capture time (Page.captureScreenshot clip.scale), so
    // a bounded attachment costs fewer pixels without changing the layout the
    // page sees. Geometry stays normalized, so callers keep the logical rect.
    async capturePage(rect, options) {
        const requested = options?.scale;
        const scale = typeof requested === "number" && Number.isFinite(requested) && requested > 0 && requested <= 1 ? requested : 1;
        const clip = rect ? { clip: { ...rect, scale } } : {};
        const shot = await this.cmd("Page.captureScreenshot", { format: "png", ...clip });
        const png = Buffer.from(String(shot.data), "base64");
        const size = pngSize(png);
        const jpeg = async (quality, width) => {
            const scaled = width && width < size.width ? { clip: { x: rect?.x ?? 0, y: rect?.y ?? 0, width: size.width, height: size.height, scale: width / size.width } } : clip;
            const out = await this.cmd("Page.captureScreenshot", { format: "jpeg", quality, ...scaled });
            return Buffer.from(String(out.data), "base64");
        };
        return new CdpImage(png, size, jpeg);
    }
    async purgeMemory() {
        if (this.destroyed)
            return;
        await this.ready.catch(() => undefined);
        await this.rawCmd("Memory.forciblyPurgeJavaScriptMemory").catch(() => undefined);
    }
    // High-level API convenience helpers for direct agent/script usage
    async evaluateJson(expression) {
        return this.evaluate(expression);
    }
    async clickAt(x, y) {
        await this.ready;
        await this.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await this.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
    async typeText(text) {
        await this.ready;
        await this.cmd("Input.insertText", { text });
    }
    async scrollBy(deltaX, deltaY, x = 0, y = 0) {
        await this.ready;
        await this.cmd("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
    }
    async waitForSelector(selector, timeoutMs = 10000) {
        await this.ready;
        const start = Date.now();
        const cleanSelector = JSON.stringify(selector);
        while (Date.now() - start < timeoutMs) {
            if (this.destroyed)
                return false;
            const found = await this.evaluate(`Boolean(document.querySelector(${cleanSelector}))`).catch(() => false);
            if (found)
                return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
    }
    close() {
        if (this.destroyed)
            return;
        const contextId = this.contextId;
        if (!this.transport) {
            this.markDestroyed();
            return;
        }
        this.transport.send("Target.closeTarget", { targetId: this.targetId })
            .then(() => (contextId && !this.options.sharedContext ? this.transport.send("Target.disposeBrowserContext", { browserContextId: contextId }) : undefined))
            .catch(() => undefined);
        this.markDestroyed();
    }
    destroy() { this.close(); }
}
// The `view` shape BrowserAdapter takes: webContents plus fixed bounds.
// Pass a transport to share one connection between many agents; the caller then owns it.
async function openCdpView(endpoint, options = {}) {
    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    const shared = typeof endpoint !== "string";
    const transport = shared ? endpoint : await connectCdpTransport(endpoint, options.commandTimeoutMs);
    await transport.send("Target.setDiscoverTargets", { discover: true });
    const webContents = await CdpWebContents.open(transport, options);
    return { webContents, getBounds: () => ({ x: 0, y: 0, width, height }), closeConnection: () => { if (!shared)
            transport.close(); } };
}
// Synchronous view for hosts that build a task's browser without awaiting. `provider` supplies the shared
// transport on first use; the page is created in the background and every call waits for it.
function createCdpView(provider, options = {}) {
    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    const webContents = new CdpWebContents(provider, options);
    let bounds = { x: 0, y: 0, width, height };
    let visible = false;
    return {
        webContents, getBounds: () => ({ ...bounds }),
        setBounds(next) {
            if (![next.x, next.y, next.width, next.height].every(Number.isFinite) || next.width < 0 || next.height < 0)
                throw new Error("invalid_view_bounds");
            bounds = { ...next };
            if (next.width > 0 && next.height > 0)
                void webContents.setViewportSize(Math.round(next.width), Math.round(next.height)).catch(() => undefined);
        },
        setVisible(value) { visible = value === true; }, getVisible: () => visible,
    };
}
module.exports = { createCdpView, CdpWebContents, connectCdpTransport, openCdpView, mergeRequestHeaders, modifierMask, keyInfo, pngSize };
