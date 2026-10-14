import events = require("node:events");
import fs = require("node:fs");
import path = require("node:path");
import os = require("node:os");
import childProcess = require("node:child_process");
import util = require("node:util");

const { CdpEngine, PERSON_PARTITION } = require("./cdp-engine");
const { acquireCdpBrowser, findChromium, isHeadlessShell } = require("./cdp-browser-host");
const { connectCdpTransport } = require("./cdp-web-contents");
const { createRendererBridge } = require("./chromium-bridge");
const { createKeychainStorage } = require("./chromium-keychain");
const execFileAsync = util.promisify(childProcess.execFile);
const packageRoot = path.resolve(__dirname, "../..");

type Json = Record<string, any>;
type Handler = (event: { senderFrame: { url: string } }, ...args: any[]) => unknown;
const handlers = new Map<string, Handler>();
const windows = new Set<BrowserWindow>();
const engines = new CdpEngine();
engines.configure({ browserEngine: "chromium", chromiumPath: process.env.HALO_CHROMIUM });
const sessions = { fromPartition: (partition = PERSON_PARTITION) => engines.sessionFor(partition) };
let uiBrowser: Promise<{ transport: any; browser: any }> | null = null;
let quitting = false;
const startedAt = Date.now();

function findUiChromium(): string {
  const configured = process.env.HALO_CHROMIUM_UI;
  const candidates = [configured, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"), findChromium()];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate) && !isHeadlessShell(candidate));
  if (!found) throw new Error("chromium_ui_missing: set HALO_CHROMIUM_UI to the full Chromium executable");
  return found;
}
function uiConnection(appUrl?: string): Promise<{ transport: any; browser: any }> {
  if (!uiBrowser) {
    uiBrowser = acquireCdpBrowser({ executablePath: findUiChromium(), headless: false, desktop: true, appUrl, profilePath: path.join(app.getPath("userData"), "chromium-ui-profile") }).then(async (browser: any) => {
      try { return { transport: await connectCdpTransport(browser.wsUrl), browser }; }
      catch (error) { await browser.close(); throw error; }
    });
    const attempt = uiBrowser!;
    attempt.catch(() => { if (uiBrowser === attempt) uiBrowser = null; });
  }
  return uiBrowser!;
}

class App extends events.EventEmitter {
  readonly isPackaged = false;
  readonly isChromium = true;
  readonly commandLine = { appendSwitch: (_name: string, _value?: string) => {} };
  private ready: Promise<void> | null = null;
  getName(): string { return "halo-computer-browser"; }
  getAppPath(): string { return path.join(packageRoot, "tools/start-chromium.js"); }
  getPath(name: string): string {
    if (name === "userData") return process.env.HALO_USER_DATA ?? path.join(os.homedir(), "Library/Application Support", this.getName());
    if (name === "home") return os.homedir();
    if (name === "temp") return os.tmpdir();
    if (name === "downloads") return path.join(os.homedir(), "Downloads");
    throw new Error(`unsupported_app_path: ${name}`);
  }
  whenReady(): Promise<void> {
    this.ready ??= Promise.resolve().then(() => { fs.mkdirSync(this.getPath("userData"), { recursive: true, mode: 0o700 }); });
    return this.ready;
  }
  isReady(): boolean { return this.ready !== null; }
  getAppMetrics(): Json[] {
    // Real RSS, including both Chromium trees. Planners and Python are counted separately by MemoryMonitor.
    const result = childProcess.spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8", timeout: 3000, maxBuffer: 2_000_000 });
    if (result.status !== 0) throw new Error("process_metrics_unavailable");
    const rows = result.stdout.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((match) => ({ pid: +match![1], parent: +match![2], rss: +match![3], command: match![4] }));
    const descendants = new Set<number>([process.pid]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
    return rows.filter((row) => descendants.has(row.pid) && (row.pid === process.pid || /chromium|headless_shell|chrome helper/i.test(row.command)))
      .map((row) => ({ pid: row.pid, creationTime: startedAt, type: row.pid === process.pid ? "Node host" : "Chromium", memory: { workingSetSize: row.rss } }));
  }
  quit(): void {
    if (quitting) return;
    let prevented = false;
    this.emit("before-quit", { preventDefault() { prevented = true; } });
    if (prevented) return;
    quitting = true;
    void (async () => {
      for (const win of [...windows]) win.destroy();
      await engines.release();
      if (uiBrowser) await uiBrowser.then(async ({ transport, browser }) => { transport.close(); await browser.close(); }).catch(() => undefined);
      this.emit("will-quit");
      process.exitCode = 0;
    })();
  }
}
const app = new App();

class WebContentsView {
  readonly webContents: any;
  private readonly page: any;
  constructor(options: Json = {}) {
    this.page = engines.createPage(options.webPreferences?.partition ?? PERSON_PARTITION);
    if (!this.page) throw new Error("chromium_page_unavailable");
    this.webContents = this.page.webContents;
  }
  setBounds(bounds: Json): void { this.page.setBounds(bounds); }
  getBounds(): Json { return this.page.getBounds(); }
  setVisible(visible: boolean): void { this.page.setVisible(visible); }
  getVisible(): boolean { return this.page.getVisible(); }
}

class BrowserWindow extends events.EventEmitter {
  static getAllWindows(): BrowserWindow[] { return [...windows].filter((win) => !win.isDestroyed()); }
  readonly webContents: events.EventEmitter & Json;
  readonly contentView: { children: any[]; addChildView(view: any): void; removeChildView(view: any): void };
  private destroyed = false;
  private size: [number, number];
  private bridge: ReturnType<typeof createRendererBridge> | null = null;
  private targetId: string | null = null;
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  trustedUiOrigin: string | null = null;
  constructor(private readonly options: Json = {}) {
    super();
    this.size = [options.width ?? 1440, options.height ?? 900];
    const children: any[] = [];
    this.contentView = { children, addChildView(view: any) { if (!children.includes(view)) children.push(view); }, removeChildView(view: any) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); } };
    const wc = new events.EventEmitter() as events.EventEmitter & Json;
    this.webContents = wc;
    wc.mainFrame = { url: "" };
    wc.send = (channel: string, payload: unknown) => this.bridge?.send(channel, payload);
    wc.setWindowOpenHandler = (_handler: unknown) => {};
    wc.isDestroyed = () => this.destroyed;
    wc.reload = () => { if (this.sessionId) void uiConnection().then(({ transport }) => transport.send("Page.reload", {}, this.sessionId)).catch(() => undefined); };
    windows.add(this);
  }
  getContentSize(): [number, number] { return [...this.size]; }
  isDestroyed(): boolean { return this.destroyed; }
  async loadFile(file: string): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.openUi(file);
    return this.loading;
  }
  private async openUi(file: string): Promise<void> {
    if (this.options.show === false || this.destroyed) return;
    const layoutArg = (this.options.webPreferences?.additionalArguments ?? []).find((arg: string) => arg.startsWith("--halo-layout="));
    const layout = layoutArg ? JSON.parse(layoutArg.slice("--halo-layout=".length)) : {};
    this.bridge = createRendererBridge({ root: path.dirname(file), layout, methods: [...handlers.keys()].filter((channel) => channel.startsWith("halo:")).map((channel) => channel.slice(5)), invoke: async (channel: string, args: unknown[]) => {
      if (this.destroyed) throw new Error("window_closed");
      if (channel === "halo:windowBounds") {
        const [width, height] = args;
        if (![width, height].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 16384)) throw new Error("invalid_window_bounds");
        this.size = [width as number, height as number]; this.emit("resize"); return true;
      }
      const handler = handlers.get(channel);
      if (!handler) throw new Error("unsupported_channel");
      return handler({ senderFrame: this.webContents.mainFrame }, ...args);
    } });
    const { url, origin } = await this.bridge.start();
    this.trustedUiOrigin = origin;
    this.webContents.mainFrame.url = `${origin}/`;
    const { transport } = await uiConnection(url);
    if (this.destroyed) { await this.bridge.close(); return; }
    const targets = await transport.send("Target.getTargets");
    const existing = targets.targetInfos.find((target: Json) => target.type === "page" && (target.url === url || target.url === `${origin}/`));
    const { targetId } = existing ?? await transport.send("Target.createTarget", { url, newWindow: true, width: this.size[0], height: this.size[1] });
    this.targetId = targetId;
    const attached = await transport.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = attached.sessionId;
    await transport.send("Page.enable", {}, this.sessionId);
    await transport.send("Target.setDiscoverTargets", { discover: true });
    this.unsubscribe = transport.onEvent((method: string, params: Json, session: string) => {
      if (method === "Target.targetDestroyed" && params.targetId === this.targetId) this.destroy();
      if (method === "Target.targetCrashed" && params.targetId === this.targetId) this.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      if (method === "Page.frameNavigated" && session === this.sessionId && !params.frame.parentId) this.webContents.mainFrame.url = params.frame.url;
    });
    this.emit("ready-to-show");
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.unsubscribe?.(); this.unsubscribe = null;
    for (const view of [...this.contentView.children]) view.webContents.close?.();
    this.contentView.children.length = 0;
    if (this.targetId) void uiConnection().then(({ transport }) => transport.send("Target.closeTarget", { targetId: this.targetId })).catch(() => undefined);
    void this.bridge?.close(); windows.delete(this); this.emit("closed");
    if (!windows.size) { app.emit("window-all-closed"); app.quit(); }
  }
  show(): void { if (this.targetId) void uiConnection().then(({ transport }) => transport.send("Target.activateTarget", { targetId: this.targetId })); }
}

const ipcMain = { handle(channel: string, handler: Handler) { if (handlers.has(channel)) throw new Error(`duplicate_channel: ${channel}`); handlers.set(channel, handler); }, removeHandler(channel: string) { handlers.delete(channel); } };
const clipboard = { writeText(text: string) {
  if (typeof text !== "string") throw new TypeError("clipboard requires text");
  const result = childProcess.spawnSync("/usr/bin/pbcopy", [], { input: text, timeout: 5000 });
  if (result.status !== 0) throw new Error("clipboard_unavailable");
} };
const dialog = { async showMessageBox(options: Json): Promise<{ response: number }> {
  if (process.platform !== "darwin") throw new Error("native_dialog_unavailable");
  const buttons: string[] = options.buttons ?? ["OK"];
  const appleScript = `on run argv\nset labels to items 3 thru -1 of argv\nset answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons labels default button (item ${Number(options.defaultId ?? 0) + 1} of labels)\nreturn button returned of answer\nend run`;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", appleScript, options.title ?? "Halo", options.message ?? "", ...buttons], { timeout: 120_000 });
    const response = buttons.indexOf(stdout.trim());
    return { response: response >= 0 ? response : Number(options.cancelId ?? buttons.length - 1) };
  } catch { return { response: Number(options.cancelId ?? buttons.length - 1) }; }
} };
const nativeTheme = { themeSource: "system" };
process.once("SIGINT", () => app.quit());
process.once("SIGTERM", () => app.quit());

export = { app, BrowserWindow, WebContentsView, ipcMain, clipboard, dialog, nativeTheme, session: sessions, safeStorage: createKeychainStorage(), cdpEngine: engines, isChromium: true };
