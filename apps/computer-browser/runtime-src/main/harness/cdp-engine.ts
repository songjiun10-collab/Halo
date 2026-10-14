"use strict";

// Browser-engine switch for the agent viewport host. While the engine is
// "electron" (the default) createPage() returns null and the host keeps its
// Electron path untouched. When the user selects "chromium", pages come from a
// Chromium they brought themselves (cdp-browser-host.ts), one isolated
// browser context per Agent partition, all over one shared connection.

const hostModule = require("./cdp-browser-host") as {
  acquireCdpBrowser(options: { endpoint?: string; executablePath?: string; extraFlags?: readonly string[] }): Promise<{ wsUrl: string; close(): Promise<void> }>;
};
// The partition of the person's own browsing tabs (chromium-desktop.ts uses it when a view names none).
const PERSON_PARTITION = "halo-direct";
const pageModule = require("./cdp-web-contents") as {
  connectCdpTransport(url: string): Promise<CdpTransportLike>;
  createCdpView(provider: () => Promise<CdpTransportLike>, options: Record<string, unknown>): unknown;
};
const { CdpSession } = require("./chromium-session") as { CdpSession: new (provider: () => Promise<{ transport: CdpTransportLike; contextId: string }>) => any };

interface CdpTransportLike { send(method: string, params?: Record<string, unknown>): Promise<any>; close(): void }
interface EngineSettings { browserEngine?: string; chromiumPath?: string; chromiumEndpoint?: string; chromiumContextPolicy?: string }
interface Connection { transport: CdpTransportLike; close(): Promise<void> }
interface Generation {
  config: EngineSettings;
  connection: Promise<Connection> | null;
  contexts: Map<string, Promise<string>>;
  sessions: Map<string, any>;
  pages: number;
  retired: boolean;
  closed: boolean;
  closing: Promise<void> | null;
  persistent: Map<string, string>;
}
interface SessionVault {
  isPersistentPartition(partition: string): boolean;
  load(partition: string): Promise<any[]>;
  save(partition: string, cookies: any[]): Promise<boolean>;
}
const SAVE_INTERVAL_MS = 30000;

// Under the "shared" policy only ordinary task pages (no saved login, no throwaway
// child profile) fall into one browser context; agent profiles (persist:halo-agent-*)
// and isolated children (halo-child-*) always keep their own.
const SHARED_POOL_PREFIX = "halo-task-";
function contextKey(policy: string | undefined, partition: string): string {
  return policy === "shared" && partition.startsWith(SHARED_POOL_PREFIX) ? "shared-tasks" : partition;
}

// Under the shared policy one renderer serves every page of the same site inside one browser context.
// Pages in different contexts never share a process, so agent profiles and isolated children are unaffected.
function sharingFlags(policy: string | undefined): { extraFlags?: readonly string[] } {
  return policy === "shared" ? { extraFlags: ["--process-per-site"] } : {};
}

class CdpEngine {
  private config: EngineSettings = {};
  private readonly generations = new Set<Generation>();
  private current: Generation | null = null;
  private vault: SessionVault | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  private currentGeneration(): Generation {
    if (!this.current) {
      this.current = { config: { ...this.config }, connection: null, contexts: new Map(), sessions: new Map(), pages: 0, retired: false, closed: false, closing: null, persistent: new Map() };
      this.generations.add(this.current);
    }
    return this.current;
  }

  configure(settings: EngineSettings | null | undefined): void {
    const next: EngineSettings = {
      browserEngine: settings?.browserEngine,
      chromiumPath: settings?.chromiumPath,
      chromiumEndpoint: settings?.chromiumEndpoint,
      chromiumContextPolicy: settings?.chromiumContextPolicy,
    };
    const changed = next.browserEngine !== this.config.browserEngine || next.chromiumPath !== this.config.chromiumPath || next.chromiumEndpoint !== this.config.chromiumEndpoint || next.chromiumContextPolicy !== this.config.chromiumContextPolicy;
    this.config = next;
    // New pages follow the new setting; pages already open finish on the browser they started on.
    if (changed && this.current) {
      const old = this.current;
      this.current = null;
      old.retired = true;
      if (!old.pages) void this.closeGeneration(old);
    }
  }
  setSessionVault(vault: SessionVault | null): void {
    this.vault = vault ?? null;
    if (!this.vault) this.stopSaveTimer();
  }

  private stopSaveTimer(): void {
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
  }

  private startSaveTimer(): void {
    if (this.saveTimer) return;
    this.saveTimer = setInterval(() => { void this.saveSessions().catch(() => undefined); }, SAVE_INTERVAL_MS);
    this.saveTimer.unref?.();
  }

  // Writes each persistent agent context's cookies into the vault. Never throws and never logs cookie values.
  async saveSessions(only?: Generation): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    for (const generation of only ? [only] : [...this.generations]) {
      if ((generation.closed && !only) || !generation.persistent.size || !generation.connection) continue;
      const connectionPromise = generation.connection;
      const contexts = new Map(generation.contexts);
      for (const [key, partition] of [...generation.persistent]) {
        try {
          const context = contexts.get(key);
          if (!context) continue;
          const [browserContextId, connection] = await Promise.all([context, connectionPromise]);
          const result = await connection.transport.send("Storage.getCookies", { browserContextId });
          if (!Array.isArray(result?.cookies)) continue;
          await vault.save(partition, result.cookies);
        } catch { /* a failed save must not break the browser */ }
      }
    }
  }

  isActive(): boolean { return this.config.browserEngine === "chromium"; }

  private connect(generation: Generation = this.currentGeneration()): Promise<Connection> {
    if (generation.closed) return Promise.reject(new Error("cdp_generation_released"));
    if (!generation.connection) {
      const { chromiumEndpoint, chromiumPath, chromiumContextPolicy } = generation.config;
      const attempt = (async () => {
        const browser = await hostModule.acquireCdpBrowser(chromiumEndpoint ? { endpoint: chromiumEndpoint } : { ...(chromiumPath ? { executablePath: chromiumPath } : {}), ...sharingFlags(chromiumContextPolicy) });
        try {
          const transport = await pageModule.connectCdpTransport(browser.wsUrl);
          return { transport, close: async () => { try { transport.close(); } finally { await browser.close(); } } };
        } catch (error) {
          // Preserve the attach error even if cleanup itself fails.
          await browser.close().catch(() => undefined);
          throw error;
        }
      })();
      // A failed start must not be cached forever: the next page retries.
      attempt.catch(() => { if (generation.connection === attempt) generation.connection = null; });
      generation.connection = attempt;
    }
    return generation.connection;
  }

  // Returns a WebContentsView-shaped page, or null when the Electron engine is selected.
  createPage(partition: string): unknown {
    if (!this.isActive()) return null;
    const generation = this.currentGeneration();
    const key = contextKey(generation.config.chromiumContextPolicy, partition);
    generation.pages += 1;
    let released = false;
    const releasePage = () => {
      if (released) return;
      released = true;
      generation.pages -= 1;
      if (generation.retired && !generation.pages) void this.closeGeneration(generation);
    };
    const provider = async () => {
      const { transport } = await this.connect(generation);
      if (generation.closed) throw new Error("cdp_generation_released");
      return transport;
    };
    try {
      const view = pageModule.createCdpView(provider, {
        isolated: true,
        // A dialog on the person's own tab is the person's to answer; every agent page answers its own at
        // once, so a dialog can never freeze a task (cdp-web-contents.ts onJavaScriptDialog).
        dialogs: partition === PERSON_PARTITION ? "ask" : "answer",
        session: this.sessionForGeneration(partition, generation),
        sharedContext: (transport: CdpTransportLike) => this.contextFor(generation, key, transport),
      }) as { webContents: { once(name: string, listener: () => void): unknown; isDestroyed?(): boolean } };
      view.webContents.once("destroyed", releasePage);
      if (view.webContents.isDestroyed?.()) releasePage();
      return view;
    } catch (error) { releasePage(); throw error; }
  }

  private contextFor(generation: Generation, key: string, transport: CdpTransportLike): Promise<string> {
    if (generation.closed) return Promise.reject(new Error("cdp_generation_released"));
    let context = generation.contexts.get(key);
    if (!context) {
      const vault = this.vault;
      const partition = vault && vault.isPersistentPartition(key) ? key : null;
      context = transport.send("Target.createBrowserContext").then(async (result) => {
        if (typeof result.browserContextId !== "string" || !result.browserContextId) throw new Error("cdp_context_unavailable");
        const browserContextId: string = result.browserContextId;
        if (vault && partition) {
          try {
            const cookies = await vault.load(partition);
            if (cookies.length) await transport.send("Storage.setCookies", { cookies, browserContextId });
          } catch { /* restoring is best effort; the context is still usable */ }
          if (!generation.closed) { generation.persistent.set(key, partition); this.startSaveTimer(); }
        }
        return browserContextId;
      });
      generation.contexts.set(key, context);
      context.catch(() => { if (generation.contexts.get(key) === context) generation.contexts.delete(key); });
    }
    return context;
  }

  sessionFor(partition: string): any {
    return this.sessionForGeneration(partition, this.currentGeneration());
  }

  private sessionForGeneration(partition: string, generation: Generation): any {
    const key = contextKey(generation.config.chromiumContextPolicy, partition);
    let session = generation.sessions.get(key);
    if (!session) {
      session = new CdpSession(async () => { const { transport } = await this.connect(generation); return { transport, contextId: await this.contextFor(generation, key, transport) }; });
      generation.sessions.set(key, session);
    }
    return session;
  }

  private closeGeneration(generation: Generation): Promise<void> {
    if (generation.closing) return generation.closing;
    // Snapshot the live state for the final save, then refuse new work at once.
    const finalSave = this.saveSessions(generation).catch(() => undefined);
    generation.closed = true;
    generation.contexts.clear();
    generation.sessions.clear();
    generation.persistent.clear();
    const connection = generation.connection;
    generation.connection = null;
    generation.closing = (async () => {
      await finalSave;
      if (connection) await connection.then((entry) => entry.close()).catch(() => undefined);
      this.generations.delete(generation);
    })();
    return generation.closing;
  }

  async release(): Promise<void> {
    this.current = null;
    // Snapshot before awaiting: concurrently created new work has its own generation.
    try { await Promise.all([...this.generations].map((generation) => this.closeGeneration(generation))); } finally { this.stopSaveTimer(); }
  }
}

export = { CdpEngine, PERSON_PARTITION };
