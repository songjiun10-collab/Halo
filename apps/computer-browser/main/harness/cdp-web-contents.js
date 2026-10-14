// Generated from runtime-src/main/harness/cdp-web-contents.ts. Do not edit; run npm run build:runtime.
"use strict";
// Same ad/tracker list the Electron agent session uses, so both engines refuse the same hosts.
const { isBlockedUrl } = require("./agent-request-filter");
const DENIED_PERMISSIONS = ["geolocation", "notifications", "camera", "microphone", "midi", "clipboard-read", "clipboard-write", "screen-wake-lock", "persistent-storage", "background-sync", "idle-detection", "window-management", "local-fonts", "display-capture"];
const MAX_DIALOG_MESSAGE = 200;
const MAX_DIALOG_NOTICES = 5;
const MAX_PERSON_DIALOG_TEXT = 500;
const MAX_PROMPT_ANSWER = 2000;
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
    webContentsId = nextWebContentsId++;
    listeners = new Map();
    unsubscribe;
    url = "about:blank";
    title = "";
    mainFrameId = "";
    httpStatus = null;
    // The main frame has started a load whose stop has not arrived yet.
    loading = false;
    history = [];
    historyIndex = -1;
    worlds = new Map();
    dialogNotices = [];
    pendingDialog = null;
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
        await this.rawCmd("Page.enable");
        await this.rawCmd("Network.enable");
        await this.rawCmd("Runtime.enable");
        await this.rawCmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        this.viewportWidth = width;
        this.viewportHeight = height;
        const tree = await this.rawCmd("Page.getFrameTree");
        this.mainFrameId = tree.frameTree.frame.id;
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
    // A page that opens alert/confirm/prompt/beforeunload stops answering until someone responds.
    // On an agent's page (dialogs "answer", the default) the host responds at once: alert and beforeunload are
    // accepted (nothing is being agreed to); confirm and prompt are cancelled, since an agent must never say
    // "yes" or type an answer to a page for the person. Each one is a short notice the planner reads in its next
    // observation. On the person's own tab (dialogs "ask") the dialog waits for the person: it is reported with
    // "javascript-dialog-opening" and answered once through answerDialog().
    onJavaScriptDialog(params) {
        const type = String(params.type ?? "alert");
        if (this.options.dialogs === "ask") {
            this.pendingDialog = {
                type,
                message: String(params.message ?? "").slice(0, MAX_PERSON_DIALOG_TEXT),
                defaultPrompt: String(params.defaultPrompt ?? "").slice(0, MAX_PERSON_DIALOG_TEXT),
            };
            this.emit("javascript-dialog-opening", { ...this.pendingDialog });
            return;
        }
        const accept = type === "alert" || type === "beforeunload";
        this.dialogNotices.push({ type, message: String(params.message ?? "").slice(0, MAX_DIALOG_MESSAGE), outcome: accept ? "accepted" : "dismissed" });
        if (this.dialogNotices.length > MAX_DIALOG_NOTICES)
            this.dialogNotices.shift();
        this.rawCmd("Page.handleJavaScriptDialog", { accept }).catch(() => undefined);
        this.emit("javascript-dialog", { type, accepted: accept });
    }
    /** The person's answer to the dialog waiting on this tab; false when none is waiting (it is answered once). */
    async answerDialog(accept, promptText) {
        const dialog = this.pendingDialog;
        if (!dialog)
            return false;
        this.pendingDialog = null;
        const params = { accept: accept === true };
        if (dialog.type === "prompt" && accept === true && typeof promptText === "string")
            params.promptText = promptText.slice(0, MAX_PROMPT_ANSWER);
        await this.rawCmd("Page.handleJavaScriptDialog", params).catch(() => undefined);
        this.emit("javascript-dialog-closed");
        return true;
    }
    /** Dialogs the host answered since the last call; reading them clears them. */
    takeDialogNotices() {
        return this.dialogNotices.splice(0);
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
        if (allowed && !isDocument && isBlockedUrl(url))
            allowed = false;
        // Electron asks "will-navigate" and "will-redirect" before the main frame moves, and the adapter
        // enforces the Intent Lock, a child's origin pin and the private-network block there; a page that
        // navigates itself (a link, a script, a redirect) never passes through the adapter otherwise.
        // Unlike Electron this also asks about loads the host started, which the adapter checked already.
        // A prevented navigation is aborted, which leaves the current page in place as Electron does
        // (any other failure would put Chromium's error page in its place).
        let reason = "BlockedByClient";
        if (allowed && isDocument && params.frameId === this.mainFrameId && /^https?:/i.test(url)) {
            let prevented = false;
            const event = { preventDefault: () => { prevented = true; } };
            this.emit(typeof params.redirectedRequestId === "string" && params.redirectedRequestId !== "" ? "will-redirect" : "will-navigate", event, url);
            if (prevented) {
                allowed = false;
                reason = "Aborted";
            }
        }
        const command = allowed ? "Fetch.continueRequest" : "Fetch.failRequest";
        this.rawCmd(command, allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: reason }).catch(() => undefined);
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
                if (!params.frame?.parentId) {
                    this.url = params.frame.url;
                    this.mainFrameId = params.frame.id;
                    this.worlds.clear();
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
                    this.loading = false;
                    this.emit("did-stop-loading");
                    this.emit("did-finish-load");
                }
                break;
            case "Page.frameStartedLoading":
                if (params.frameId === this.mainFrameId) {
                    this.loading = true;
                    this.emit("did-start-navigation", {}, this.url, false, true);
                }
                break;
            case "Page.javascriptDialogOpening":
                this.onJavaScriptDialog(params);
                break;
            case "Page.javascriptDialogClosed":
                // Closed some other way (the page navigated away): nothing is waiting for the person any more.
                if (this.pendingDialog) {
                    this.pendingDialog = null;
                    this.emit("javascript-dialog-closed");
                }
                break;
            case "Page.domContentEventFired":
                this.emit("dom-ready");
                break;
            case "Runtime.executionContextsCleared":
                this.worlds.clear();
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
            await this.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
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
    async navigate(url) {
        if (this.destroyed)
            throw new Error("cdp_destroyed: page is closed");
        const stopped = new Promise((resolve) => {
            const done = () => { this.removeListener("did-stop-loading", done); this.removeListener("destroyed", done); resolve(); };
            this.on("did-stop-loading", done);
            this.on("destroyed", done);
        });
        const result = await this.rawCmd("Page.navigate", { url });
        if (result.errorText) {
            // A load that started and then failed (a redirect the adapter stopped) still has its stop to come.
            // Wait for it here, or the next navigation would take that late stop for its own and report done
            // before its page has committed.
            if (this.loading)
                await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 2000))]);
            this.emit("did-fail-load", {}, -1, String(result.errorText), url, true);
            throw new Error(`navigation_error: ${result.errorText}`);
        }
        if (result.loaderId)
            await stopped;
    }
    stop() { this.cmd("Page.stopLoading").catch(() => undefined); }
    async executeJavaScript(code) {
        return this.evaluate(code);
    }
    async executeJavaScriptInIsolatedWorld(worldId, scripts, _userGesture) {
        let contextId = this.worlds.get(worldId);
        if (contextId === undefined) {
            const created = await this.cmd("Page.createIsolatedWorld", { frameId: this.mainFrameId, worldName: `halo-${worldId}`, grantUniveralAccess: false });
            contextId = created.executionContextId;
            this.worlds.set(worldId, contextId);
        }
        let value;
        for (const script of scripts)
            value = await this.evaluate(script.code, contextId);
        return value;
    }
    async evaluate(expression, contextId) {
        const result = await this.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...(contextId === undefined ? {} : { contextId }) });
        if (result.exceptionDetails)
            throw new Error(`script_error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed"}`);
        return result.result?.value;
    }
    sendInputEvent(event) {
        const modifiers = modifierMask(event.modifiers);
        const swallow = (promise) => { promise.catch(() => undefined); };
        switch (event.type) {
            case "mouseMove":
                swallow(this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: event.x, y: event.y, modifiers }));
                break;
            case "mouseDown":
            case "mouseUp":
                swallow(this.cmd("Input.dispatchMouseEvent", {
                    type: event.type === "mouseDown" ? "mousePressed" : "mouseReleased", x: event.x, y: event.y, modifiers,
                    button: event.button ?? "left", clickCount: event.clickCount ?? 1,
                }));
                break;
            case "mouseWheel":
                swallow(this.cmd("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0, modifiers }));
                break;
            case "keyDown":
            case "keyUp": {
                const info = keyInfo(String(event.keyCode));
                swallow(this.cmd("Input.dispatchKeyEvent", {
                    type: event.type === "keyDown" ? "rawKeyDown" : "keyUp", key: info.key, code: info.code,
                    windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers,
                }));
                break;
            }
            case "char": {
                const info = keyInfo(String(event.keyCode));
                const text = info.text ?? info.key;
                swallow(this.cmd("Input.dispatchKeyEvent", { type: "char", key: info.key, code: info.code, text, unmodifiedText: text, modifiers }));
                break;
            }
            default:
                break;
        }
    }
    insertText(text) { this.cmd("Input.insertText", { text }).catch(() => undefined); }
    selectAll() {
        this.cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIER_BITS.meta, commands: ["selectAll"] })
            .then(() => this.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIER_BITS.meta }))
            .catch(() => undefined);
    }
    async captureJpeg({ maxWidth, quality }) {
        if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 8192 || !Number.isInteger(quality) || quality < 1 || quality > 100)
            throw new Error("invalid_capture_options");
        await this.ready;
        await this.viewportChange;
        const width = this.viewportWidth, height = this.viewportHeight;
        const shot = await this.cmd("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false,
            clip: { x: 0, y: 0, width, height, scale: Math.min(1, maxWidth / width) } });
        return Buffer.from(String(shot.data), "base64");
    }
    // Push-based live view: Chromium sends a JPEG only when the page paints something new.
    async startScreencast({ maxWidth, quality }, onFrame) {
        if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 8192 || !Number.isInteger(quality) || quality < 1 || quality > 100)
            throw new Error("invalid_capture_options");
        await this.ready;
        await this.viewportChange;
        this.screencast = onFrame;
        await this.cmd("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight: Math.min(8192, Math.round(maxWidth * 2)), everyNthFrame: 1 });
    }
    async stopScreencast() {
        this.screencast = null;
        if (this.destroyed)
            return;
        await this.cmd("Page.stopScreencast").catch(() => undefined);
    }
    async capturePage(rect) {
        const clip = rect ? { clip: { ...rect, scale: 1 } } : {};
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
module.exports = { createCdpView, CdpWebContents, connectCdpTransport, openCdpView, modifierMask, keyInfo, pngSize };
