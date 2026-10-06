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

import events = require("node:events");

type Lifecycle = "active" | "frozen" | "discarded";

interface InnerPage {
  view: any;                 // WebContentsView-shaped (Electron or CDP page)
  dispose(): void;           // detach from its host window / release shared resources
}
interface ParkableOptions {
  create: () => InnerPage;
  lazy?: boolean;            // start parked: no renderer until the first use
  getSession?: () => unknown; // the partition's session, readable before any renderer exists
  width?: number;
  height?: number;
  now?: () => number;
}

const FORWARDED_EVENTS = ["did-navigate", "did-navigate-in-page", "did-stop-loading", "did-fail-load", "page-title-updated", "will-navigate", "will-redirect"] as const;
let nextProxyId = 1;

class SurfaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "SurfaceError"; this.code = code; }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch { return false; }
}

class ParkableView {
  readonly webContents: any;
  state: Lifecycle = "active";
  lastUsedAt: number;
  private inner: InnerPage | null;
  private readonly opts: ParkableOptions;
  private readonly now: () => number;
  private savedUrl = "about:blank";
  private savedTitle = "";
  private session: unknown = undefined;
  private inflight = 0;
  private restoring: Promise<void> | null = null;
  private closed = false;
  private freezeBroken = false;
  private unhook: Array<() => void> = [];

  constructor(opts: ParkableOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.lastUsedAt = this.now();
    this.inner = opts.lazy ? null : opts.create();
    if (opts.lazy) this.state = "discarded";
    this.session = opts.getSession ? safeCall(opts.getSession, undefined) : undefined;
    this.webContents = this.buildProxy();
    if (this.inner) this.hook(this.inner);
  }

  // ---- view surface used by BrowserAdapter / AgentViewportHost
  getBounds() { return { x: 0, y: 0, width: this.opts.width ?? 1280, height: this.opts.height ?? 800 }; }
  setBounds(bounds: unknown) { this.inner?.view.setBounds?.(bounds); }
  setVisible(visible: boolean) { this.inner?.view.setVisible?.(visible); }
  isLive(): boolean { return this.state === "active" && !!this.inner && !this.closed; }
  holdsRenderer(): boolean { return this.state !== "discarded" && !!this.inner && !this.closed; }
  isBusy(): boolean { return this.inflight > 0 || this.restoring !== null; }
  idleMs(): number { return this.now() - this.lastUsedAt; }

  // ---- lifecycle transitions (driven by SurfacePool, safe to call any time)
  async freeze(): Promise<boolean> {
    if (this.state !== "active" || !this.inner || this.isBusy() || this.freezeBroken || this.closed) return false;
    try {
      await this.lifecycleCommand("frozen");
      if (this.isBusy() || this.state !== "active") { await this.lifecycleCommand("active").catch(() => undefined); return false; }
      this.state = "frozen";
      return true;
    } catch { this.freezeBroken = true; return false; }
  }

  async discard(): Promise<boolean> {
    if (this.state === "discarded" || !this.inner || this.isBusy() || this.closed) return false;
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
  wake(): Promise<void> { return this.use(true, () => undefined); }

  // Brings a discarded or frozen surface back before a call runs against it.
  private async ensureLive(loadSaved: boolean): Promise<void> {
    if (this.closed) throw new SurfaceError("surface_closed", "the agent surface was closed");
    if (this.state === "discarded") {
      if (!this.restoring) {
        this.restoring = (async () => {
          const inner = this.opts.create();
          this.inner = inner;
          this.hook(inner);
          this.state = "active";
          if (loadSaved && this.savedUrl !== "about:blank") await inner.view.webContents.loadURL(this.savedUrl);
        })().finally(() => { this.restoring = null; });
      }
      await this.restoring;
    } else if (this.state === "frozen") {
      await this.lifecycleCommand("active");
      this.state = "active";
    }
  }

  private async lifecycleCommand(state: "frozen" | "active"): Promise<void> {
    const wc = this.inner?.view.webContents;
    if (!wc) return;
    if (typeof wc.rawCmd === "function") { await wc.rawCmd("Page.setWebLifecycleState", { state }); return; }
    const dbg = wc.debugger;
    if (!dbg) throw new SurfaceError("freeze_unsupported", "no debugger channel");
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Page.setWebLifecycleState", { state });
  }

  private hook(inner: InnerPage) {
    const wc = inner.view.webContents;
    for (const name of FORWARDED_EVENTS) {
      const forward = (...args: unknown[]) => { if (this.inner === inner) this.webContents.emit(name, ...args); };
      wc.on(name, forward);
      this.unhook.push(() => wc.removeListener?.(name, forward));
    }
    this.session ??= safeCall(() => wc.session, undefined);
  }

  private release(inner: InnerPage) {
    for (const off of this.unhook.splice(0)) safeCall(off, undefined);
    try { inner.view.webContents.close?.(); } catch { /* already gone */ }
    try { inner.dispose(); } catch { /* best effort */ }
  }

  private async use<T>(loadSaved: boolean, fn: (wc: any) => T | Promise<T>): Promise<T> {
    this.lastUsedAt = this.now();
    this.inflight += 1;
    try {
      await this.ensureLive(loadSaved);
      this.lastUsedAt = this.now();
      return await fn(this.inner!.view.webContents);
    } finally { this.inflight -= 1; this.lastUsedAt = this.now(); }
  }

  private requireLive(): any {
    if (this.closed || !this.inner) throw new SurfaceError("surface_parked", "the agent surface has no live renderer");
    if (this.state !== "active") throw new SurfaceError("surface_frozen", "the agent surface is frozen");
    this.lastUsedAt = this.now();
    return this.inner.view.webContents;
  }

  private buildProxy(): any {
    const self = this;
    const proxy: any = new events.EventEmitter();
    proxy.setMaxListeners(0);
    proxy.id = 1_000_000 + nextProxyId++;
    proxy.getURL = () => (self.inner ? safeCall(() => self.inner!.view.webContents.getURL(), self.savedUrl) : self.savedUrl);
    proxy.getTitle = () => (self.inner ? safeCall(() => self.inner!.view.webContents.getTitle(), self.savedTitle) : self.savedTitle);
    proxy.isDestroyed = () => self.closed;
    Object.defineProperty(proxy, "session", { get: () => self.session });
    Object.defineProperty(proxy, "navigationHistory", {
      get: () => self.inner?.view.webContents.navigationHistory ?? { canGoBack: () => false, canGoForward: () => false, getActiveIndex: () => 0, length: () => 1 },
    });
    // Navigation replaces the page, so a discarded surface needs no restore first.
    proxy.loadURL = (url: string, options?: unknown) => self.use(false, (wc) => wc.loadURL(url, options));
    for (const method of ["executeJavaScript", "executeJavaScriptInIsolatedWorld", "capturePage", "stop"]) {
      proxy[method] = (...args: unknown[]) => self.use(true, (wc) => wc[method](...args));
    }
    // Synchronous input never wakes a surface; it fails closed instead.
    for (const method of ["sendInputEvent", "insertText", "selectAll"]) {
      proxy[method] = (...args: unknown[]) => self.requireLive()[method](...args);
    }
    proxy.close = () => self.shutdown();
    proxy.destroy = () => self.shutdown();
    return proxy;
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    const inner = this.inner;
    this.inner = null;
    this.state = "discarded";
    if (inner) this.release(inner);
    this.webContents.emit("destroyed");
  }
}

// A restore fires did-navigate, which the adapter rightly treats as a page change
// during an observation in flight. So the surface is woken *before* these calls begin.
const WAKE_METHODS = ["observe", "execute", "captureScreenshot", "captureScreenGeometry"] as const;
function wakeOnUse<T extends object>(adapter: T, view: ParkableView): T {
  for (const name of WAKE_METHODS) {
    const original = (adapter as any)[name];
    if (typeof original !== "function") continue;
    (adapter as any)[name] = async (...args: unknown[]) => { await view.wake(); return original.apply(adapter, args); };
  }
  return adapter;
}

function safeCall<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

interface PoolPolicy {
  maxActive: number;        // live (active or frozen) renderers kept; more are discarded LRU
  freezeAfterMs: number;    // idle time before a live renderer is frozen
  discardAfterMs: number;   // idle time before a renderer is discarded
  minIdleMs: number;        // an over-cap surface must still have been idle this long
  idleShutdownMs: number;   // no live renderer for this long -> onIdle (the whole browser can exit); 0 = never
}
const DEFAULT_POLICY: PoolPolicy = Object.freeze({ maxActive: 6, freezeAfterMs: 8_000, discardAfterMs: 120_000, minIdleMs: 3_000, idleShutdownMs: 30_000 });

class SurfacePool {
  private readonly surfaces = new Map<string, ParkableView>();
  private readonly pins = new Map<string, number>();
  private readonly policy: PoolPolicy;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onIdle: (() => void | Promise<void>) | null;
  private readonly now: () => number;
  private idleSince: number | null = null;

  constructor(policy: Partial<PoolPolicy> = {}, hooks: { onIdle?: () => void | Promise<void>; now?: () => number } = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.onIdle = hooks.onIdle ?? null;
    this.now = hooks.now ?? Date.now;
  }

  register(id: string, view: ParkableView) { this.surfaces.set(id, view); }
  unregister(id: string) { this.surfaces.delete(id); this.pins.delete(id); }
  // A pinned surface is never frozen or discarded (e.g. a page the user is looking at).
  pin(id: string) { this.pins.set(id, (this.pins.get(id) ?? 0) + 1); }
  unpin(id: string) { const n = (this.pins.get(id) ?? 0) - 1; if (n > 0) this.pins.set(id, n); else this.pins.delete(id); }
  counts() {
    const out = { active: 0, frozen: 0, discarded: 0 };
    for (const view of this.surfaces.values()) out[view.state] += 1;
    return out;
  }

  private candidates(): Array<[string, ParkableView]> {
    return [...this.surfaces].filter(([id, view]) => !this.pins.has(id) && !view.isBusy());
  }

  // One pass of the policy. Safe to call at any time and from any number of places.
  async sweep(): Promise<void> {
    const { freezeAfterMs, discardAfterMs, minIdleMs, maxActive } = this.policy;
    const idle = this.candidates().sort((a, b) => b[1].idleMs() - a[1].idleMs());
    for (const [, view] of idle) {
      if (view.idleMs() >= discardAfterMs) await view.discard();
      else if (view.idleMs() >= freezeAfterMs && view.state === "active") await view.freeze();
    }
    let live = [...this.surfaces.values()].filter((v) => v.state !== "discarded").length;
    for (const [, view] of this.candidates().sort((a, b) => b[1].idleMs() - a[1].idleMs())) {
      if (live <= maxActive) break;
      if (view.state !== "discarded" && view.idleMs() >= minIdleMs && (await view.discard())) live -= 1;
    }
    await this.checkIdle();
  }

  // Nothing alive, busy or pinned for idleShutdownMs: tell the owner the browser process can go.
  // Fires once per idle stretch; the next live surface re-arms it.
  private async checkIdle(): Promise<void> {
    if (!this.onIdle || this.policy.idleShutdownMs <= 0) return;
    const inUse = this.pins.size > 0 || [...this.surfaces.values()].some((v) => v.isBusy() || v.holdsRenderer());
    if (inUse) { this.idleSince = null; return; }
    const now = this.now();
    if (this.idleSince === null) { this.idleSince = now; return; }
    if (now - this.idleSince < this.policy.idleShutdownMs) return;
    this.idleSince = Number.POSITIVE_INFINITY;
    await Promise.resolve(this.onIdle()).catch(() => undefined);
  }

  // Memory pressure: "soft" freezes everything idle, "hard" discards idle surfaces, oldest first.
  async relieve(level: "soft" | "hard", minIdleMs = this.policy.minIdleMs): Promise<number> {
    let changed = 0;
    for (const [, view] of this.candidates().filter(([, v]) => v.idleMs() >= minIdleMs).sort((a, b) => b[1].idleMs() - a[1].idleMs())) {
      if (level === "hard" ? await view.discard() : view.state === "active" && (await view.freeze())) changed += 1;
    }
    return changed;
  }

  start(intervalMs = 2_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export = { ParkableView, SurfacePool, SurfaceError, DEFAULT_POLICY, wakeOnUse };
