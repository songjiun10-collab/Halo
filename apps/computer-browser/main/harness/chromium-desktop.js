// Generated from runtime-src/main/harness/chromium-desktop.ts. Do not edit; run npm run build:runtime.
"use strict";
const events = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const util = require("node:util");
const { CdpEngine, PERSON_PARTITION } = require("./cdp-engine");
const { acquireCdpBrowser, findChromium, isHeadlessShell } = require("./cdp-browser-host");
const { connectCdpTransport } = require("./cdp-web-contents");
const { createRendererBridge } = require("./chromium-bridge");
const { createKeychainStorage } = require("./chromium-keychain");
const execFileAsync = util.promisify(childProcess.execFile);
const packageRoot = path.resolve(__dirname, "../..");
const handlers = new Map();
const windows = new Set();
const engines = new CdpEngine();
engines.configure({ browserEngine: "chromium", chromiumPath: process.env.HALO_CHROMIUM });
const sessions = { fromPartition: (partition = PERSON_PARTITION) => engines.sessionFor(partition) };
let uiBrowser = null;
let quitting = false;
const startedAt = Date.now();
function findUiChromium() {
    const configured = process.env.HALO_CHROMIUM_UI;
    const candidates = [configured, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"), findChromium()];
    const found = candidates.find((candidate) => candidate && fs.existsSync(candidate) && !isHeadlessShell(candidate));
    if (!found)
        throw new Error("chromium_ui_missing: set HALO_CHROMIUM_UI to the full Chromium executable");
    return found;
}
function uiConnection(appUrl) {
    if (!uiBrowser) {
        uiBrowser = acquireCdpBrowser({ executablePath: findUiChromium(), headless: false, desktop: true, appUrl, profilePath: path.join(app.getPath("userData"), "chromium-ui-profile") }).then(async (browser) => {
            try {
                return { transport: await connectCdpTransport(browser.wsUrl), browser };
            }
            catch (error) {
                await browser.close();
                throw error;
            }
        });
        const attempt = uiBrowser;
        attempt.catch(() => { if (uiBrowser === attempt)
            uiBrowser = null; });
    }
    return uiBrowser;
}
class App extends events.EventEmitter {
    isPackaged = false;
    isChromium = true;
    commandLine = { appendSwitch: (_name, _value) => { } };
    ready = null;
    getName() { return "halo-computer-browser"; }
    getAppPath() { return path.join(packageRoot, "tools/start-chromium.js"); }
    getPath(name) {
        if (name === "userData")
            return process.env.HALO_USER_DATA ?? path.join(os.homedir(), "Library/Application Support", this.getName());
        if (name === "home")
            return os.homedir();
        if (name === "temp")
            return os.tmpdir();
        if (name === "downloads")
            return path.join(os.homedir(), "Downloads");
        throw new Error(`unsupported_app_path: ${name}`);
    }
    whenReady() {
        this.ready ??= Promise.resolve().then(() => { fs.mkdirSync(this.getPath("userData"), { recursive: true, mode: 0o700 }); });
        return this.ready;
    }
    isReady() { return this.ready !== null; }
    getAppMetrics() {
        // Real RSS, including both Chromium trees. Planners and Python are counted separately by MemoryMonitor.
        const result = childProcess.spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8", timeout: 3000, maxBuffer: 2_000_000 });
        if (result.status !== 0)
            throw new Error("process_metrics_unavailable");
        const rows = result.stdout.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((match) => ({ pid: +match[1], parent: +match[2], rss: +match[3], command: match[4] }));
        const descendants = new Set([process.pid]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const row of rows)
                if (descendants.has(row.parent) && !descendants.has(row.pid)) {
                    descendants.add(row.pid);
                    changed = true;
                }
        }
        return rows.filter((row) => descendants.has(row.pid) && (row.pid === process.pid || /chromium|headless_shell|chrome helper/i.test(row.command)))
            .map((row) => ({ pid: row.pid, creationTime: startedAt, type: row.pid === process.pid ? "Node host" : "Chromium", memory: { workingSetSize: row.rss } }));
    }
    quit() {
        if (quitting)
            return;
        let prevented = false;
        this.emit("before-quit", { preventDefault() { prevented = true; } });
        if (prevented)
            return;
        quitting = true;
        void (async () => {
            for (const win of [...windows])
                win.destroy();
            await engines.release();
            if (uiBrowser)
                await uiBrowser.then(async ({ transport, browser }) => { transport.close(); await browser.close(); }).catch(() => undefined);
            this.emit("will-quit");
            process.exitCode = 0;
        })();
    }
}
const app = new App();
class WebContentsView {
    webContents;
    page;
    constructor(options = {}) {
        this.page = engines.createPage(options.webPreferences?.partition ?? PERSON_PARTITION);
        if (!this.page)
            throw new Error("chromium_page_unavailable");
        this.webContents = this.page.webContents;
    }
    setBounds(bounds) { this.page.setBounds(bounds); }
    getBounds() { return this.page.getBounds(); }
    setVisible(visible) { this.page.setVisible(visible); }
    getVisible() { return this.page.getVisible(); }
}
class BrowserWindow extends events.EventEmitter {
    options;
    static getAllWindows() { return [...windows].filter((win) => !win.isDestroyed()); }
    webContents;
    contentView;
    destroyed = false;
    size;
    bridge = null;
    targetId = null;
    sessionId = null;
    unsubscribe = null;
    loading = null;
    trustedUiOrigin = null;
    constructor(options = {}) {
        super();
        this.options = options;
        this.size = [options.width ?? 1440, options.height ?? 900];
        const children = [];
        this.contentView = { children, addChildView(view) { if (!children.includes(view))
                children.push(view); }, removeChildView(view) { const index = children.indexOf(view); if (index >= 0)
                children.splice(index, 1); } };
        const wc = new events.EventEmitter();
        this.webContents = wc;
        wc.mainFrame = { url: "" };
        wc.send = (channel, payload) => this.bridge?.send(channel, payload);
        wc.setWindowOpenHandler = (_handler) => { };
        wc.isDestroyed = () => this.destroyed;
        wc.reload = () => { if (this.sessionId)
            void uiConnection().then(({ transport }) => transport.send("Page.reload", {}, this.sessionId)).catch(() => undefined); };
        windows.add(this);
    }
    getContentSize() { return [...this.size]; }
    isDestroyed() { return this.destroyed; }
    async loadFile(file) {
        if (this.loading)
            return this.loading;
        this.loading = this.openUi(file);
        return this.loading;
    }
    async openUi(file) {
        if (this.options.show === false || this.destroyed)
            return;
        const layoutArg = (this.options.webPreferences?.additionalArguments ?? []).find((arg) => arg.startsWith("--halo-layout="));
        const layout = layoutArg ? JSON.parse(layoutArg.slice("--halo-layout=".length)) : {};
        this.bridge = createRendererBridge({ root: path.dirname(file), layout, methods: [...handlers.keys()].filter((channel) => channel.startsWith("halo:")).map((channel) => channel.slice(5)), invoke: async (channel, args) => {
                if (this.destroyed)
                    throw new Error("window_closed");
                if (channel === "halo:windowBounds") {
                    const [width, height] = args;
                    if (![width, height].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 16384))
                        throw new Error("invalid_window_bounds");
                    this.size = [width, height];
                    this.emit("resize");
                    return true;
                }
                const handler = handlers.get(channel);
                if (!handler)
                    throw new Error("unsupported_channel");
                return handler({ senderFrame: this.webContents.mainFrame }, ...args);
            } });
        const { url, origin } = await this.bridge.start();
        this.trustedUiOrigin = origin;
        this.webContents.mainFrame.url = `${origin}/`;
        const { transport } = await uiConnection(url);
        if (this.destroyed) {
            await this.bridge.close();
            return;
        }
        const targets = await transport.send("Target.getTargets");
        const existing = targets.targetInfos.find((target) => target.type === "page" && (target.url === url || target.url === `${origin}/`));
        const { targetId } = existing ?? await transport.send("Target.createTarget", { url, newWindow: true, width: this.size[0], height: this.size[1] });
        this.targetId = targetId;
        const attached = await transport.send("Target.attachToTarget", { targetId, flatten: true });
        this.sessionId = attached.sessionId;
        await transport.send("Page.enable", {}, this.sessionId);
        await transport.send("Target.setDiscoverTargets", { discover: true });
        this.unsubscribe = transport.onEvent((method, params, session) => {
            if (method === "Target.targetDestroyed" && params.targetId === this.targetId)
                this.destroy();
            if (method === "Target.targetCrashed" && params.targetId === this.targetId)
                this.webContents.emit("render-process-gone", {}, { reason: "crashed" });
            if (method === "Page.frameNavigated" && session === this.sessionId && !params.frame.parentId)
                this.webContents.mainFrame.url = params.frame.url;
        });
        this.emit("ready-to-show");
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const view of [...this.contentView.children])
            view.webContents.close?.();
        this.contentView.children.length = 0;
        if (this.targetId)
            void uiConnection().then(({ transport }) => transport.send("Target.closeTarget", { targetId: this.targetId })).catch(() => undefined);
        void this.bridge?.close();
        windows.delete(this);
        this.emit("closed");
        if (!windows.size) {
            app.emit("window-all-closed");
            app.quit();
        }
    }
    show() { if (this.targetId)
        void uiConnection().then(({ transport }) => transport.send("Target.activateTarget", { targetId: this.targetId })); }
}
const ipcMain = { handle(channel, handler) { if (handlers.has(channel))
        throw new Error(`duplicate_channel: ${channel}`); handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } };
const clipboard = { writeText(text) {
        if (typeof text !== "string")
            throw new TypeError("clipboard requires text");
        const result = childProcess.spawnSync("/usr/bin/pbcopy", [], { input: text, timeout: 5000 });
        if (result.status !== 0)
            throw new Error("clipboard_unavailable");
    } };
const dialog = { async showMessageBox(options) {
        if (process.platform !== "darwin")
            throw new Error("native_dialog_unavailable");
        const buttons = options.buttons ?? ["OK"];
        const appleScript = `on run argv\nset labels to items 3 thru -1 of argv\nset answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons labels default button (item ${Number(options.defaultId ?? 0) + 1} of labels)\nreturn button returned of answer\nend run`;
        try {
            const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", appleScript, options.title ?? "Halo", options.message ?? "", ...buttons], { timeout: 120_000 });
            const response = buttons.indexOf(stdout.trim());
            return { response: response >= 0 ? response : Number(options.cancelId ?? buttons.length - 1) };
        }
        catch {
            return { response: Number(options.cancelId ?? buttons.length - 1) };
        }
    } };
const nativeTheme = { themeSource: "system" };
process.once("SIGINT", () => app.quit());
process.once("SIGTERM", () => app.quit());
module.exports = { app, BrowserWindow, WebContentsView, ipcMain, clipboard, dialog, nativeTheme, session: sessions, safeStorage: createKeychainStorage(), cdpEngine: engines, isChromium: true };
