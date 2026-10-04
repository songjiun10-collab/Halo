"use strict";

// One window's view of the background runtime, in the shape the renderer's
// BackgroundRuntimeApi expects (frontend/src/session/background-runtime.ts).
//
// A window is bound at creation to either its own local TaskHost or a
// BackgroundRuntimeClient attached to the --halo-background-service process
// (main/index.js createWindow). It never switches at runtime: re-pointing a
// live window would orphan the tasks its current host owns. So attach()
// only reports the binding, detach() is refused (closing the window is the
// detach path), and stopService() is the explicit user stop of the service.

type MemoryPolicy = "budgeted" | "user_override";
interface HostSettings {
  memoryPolicy?: unknown;
}
interface BackgroundRuntimeHost {
  getHostSettings(): HostSettings | null | undefined | Promise<HostSettings | null | undefined>;
  updateHostSettings(patch: { memoryPolicy: MemoryPolicy }): HostSettings | null | undefined | Promise<HostSettings | null | undefined>;
  stopService?(reason: string): unknown;
  detach?(): unknown;
  onServiceStopping?(listener: () => void): unknown;
}
interface LaunchAgent {
  isInstalled(): unknown;
  enable(options?: { deferStart?: boolean }): unknown;
  disable(): unknown;
}
interface BackgroundRuntimeUiOptions {
  host?: BackgroundRuntimeHost | null;
  launchAgentInstalled?: () => unknown;
  launchAgent?: LaunchAgent | null;
}
interface BackgroundRuntimeSnapshot {
  connection: "connected" | "disconnected";
  service: "running" | "stopped";
  memoryPolicy: MemoryPolicy;
  launchAgentInstalled?: boolean;
}
type SnapshotListener = (snapshot: BackgroundRuntimeSnapshot) => unknown;

const MEMORY_POLICIES = Object.freeze(["budgeted", "user_override"] as const);

class BackgroundRuntimeUiError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BackgroundRuntimeUiError";
    this.code = code;
  }
}

const isRuntimeClient = (host: BackgroundRuntimeHost | null | undefined) => typeof host?.stopService === "function" && typeof host?.detach === "function";

class BackgroundRuntimeUi {
  declare _launchAgent: LaunchAgent | null;
  declare _launchAgentInstalled: (() => unknown) | null;
  declare _installed: boolean | undefined;
  declare _host: BackgroundRuntimeHost;
  declare _attached: boolean;
  declare _stopped: boolean;
  declare _memoryPolicy: MemoryPolicy;
  declare _listeners: Set<SnapshotListener>;

  // launchAgentInstalled: optional async () => boolean (LaunchAgentManager.
  // isInstalled bound to this app's label). Left out of the snapshot when
  // absent or failing: unknown is not "not installed".
  // launchAgent: optional {isInstalled, enable, disable}
  // (background-launch-agent.js); it also answers launchAgentInstalled and
  // makes setLaunchAtLogin available.
  constructor({ host, launchAgentInstalled, launchAgent }: BackgroundRuntimeUiOptions = {}) {
    if (launchAgentInstalled !== undefined && typeof launchAgentInstalled !== "function") {
      throw new BackgroundRuntimeUiError("invalid_config", "launchAgentInstalled must be a function");
    }
    if (launchAgent !== undefined && launchAgent !== null && !(["isInstalled", "enable", "disable"] as const).every((name) => typeof launchAgent[name] === "function")) {
      throw new BackgroundRuntimeUiError("invalid_config", "launchAgent needs isInstalled, enable and disable");
    }
    this._launchAgent = launchAgent ?? null;
    this._launchAgentInstalled = launchAgentInstalled ?? (this._launchAgent ? () => this._launchAgent!.isInstalled() : null);
    this._installed = undefined;
    if (!host || typeof host.getHostSettings !== "function" || typeof host.updateHostSettings !== "function") {
      throw new BackgroundRuntimeUiError("invalid_config", "host with getHostSettings/updateHostSettings is required");
    }
    this._host = host;
    this._attached = isRuntimeClient(host);
    this._stopped = false;
    this._memoryPolicy = "budgeted";
    this._listeners = new Set();
    if (this._attached && typeof host.onServiceStopping === "function") {
      host.onServiceStopping(() => this._serviceGone());
    }
  }

  async getSnapshot(): Promise<BackgroundRuntimeSnapshot> {
    await this._refreshInstalled();
    // A stopped service's client is closed; its last known policy stands.
    if (this._stopped) return this._snapshot();
    try {
      const settings = await this._host.getHostSettings();
      if (MEMORY_POLICIES.includes(settings?.memoryPolicy as MemoryPolicy)) this._memoryPolicy = settings!.memoryPolicy as MemoryPolicy;
    } catch (error) {
      // A local host failing to read its settings is a real error; a remote
      // one keeps the last known policy and reports the connection instead.
      if (!this._attached) throw error;
    }
    return this._snapshot();
  }

  // Re-reads and pushes this window's snapshot, e.g. after another window
  // changed the shared memory policy. Never throws.
  async refresh(): Promise<void> {
    try {
      this._emit(await this.getSnapshot());
    } catch {
      // A local host that cannot read its settings keeps its last push.
    }
  }

  async attach(): Promise<BackgroundRuntimeSnapshot> {
    return this.getSnapshot();
  }

  async detach(): Promise<never> {
    throw new BackgroundRuntimeUiError("detach_unsupported", "close the window to detach it from the background service");
  }

  async setMemoryPolicy(mode: unknown): Promise<BackgroundRuntimeSnapshot> {
    if (!MEMORY_POLICIES.includes(mode as MemoryPolicy)) {
      throw new BackgroundRuntimeUiError("invalid_memory_policy", `memoryPolicy must be one of ${MEMORY_POLICIES.join("|")}`);
    }
    const settings = await this._host.updateHostSettings({ memoryPolicy: mode as MemoryPolicy });
    this._memoryPolicy = MEMORY_POLICIES.includes(settings?.memoryPolicy as MemoryPolicy) ? settings!.memoryPolicy as MemoryPolicy : mode as MemoryPolicy;
    const snapshot = this._snapshot();
    this._emit(snapshot);
    return snapshot;
  }

  async stopService(): Promise<BackgroundRuntimeSnapshot> {
    if (!this._attached) {
      throw new BackgroundRuntimeUiError("no_background_service", "this window is not attached to a background service");
    }
    await this._host.stopService!("user_stop");
    // The client may not see its own serviceStopping broadcast before the
    // socket closes, so mark the service gone here as well (idempotent).
    this._serviceGone();
    return this._snapshot();
  }

  // Explicit user toggle: install-and-load or unload-and-remove the
  // background service's LaunchAgent.
  async setLaunchAtLogin(enabled: unknown): Promise<BackgroundRuntimeSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new BackgroundRuntimeUiError("invalid_launch_at_login", "enabled must be true or false");
    }
    if (!this._launchAgent) {
      throw new BackgroundRuntimeUiError("launch_agent_unavailable", "starting at login is not available here");
    }
    // A local TaskHost and a bootstrapped background service would own
    // separate in-memory coordinators over the same durable stores. Install
    // the login job without starting it now; launchd will start it at the
    // next login, after this local host is gone.
    await (enabled
      ? this._launchAgent.enable(this._attached ? undefined : { deferStart: true })
      : this._launchAgent.disable());
    await this._refreshInstalled();
    const snapshot = this._snapshot();
    this._emit(snapshot);
    return snapshot;
  }

  onChange(listener: SnapshotListener): () => boolean {
    if (typeof listener !== "function") throw new TypeError("onChange requires a listener function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _serviceGone(): void {
    if (!this._attached) return;
    this._attached = false;
    this._stopped = true;
    this._emit(this._snapshot());
  }

  async _refreshInstalled(): Promise<void> {
    if (!this._launchAgentInstalled) return;
    try {
      const installed = await this._launchAgentInstalled();
      this._installed = typeof installed === "boolean" ? installed : undefined;
    } catch {
      this._installed = undefined;
    }
  }

  _snapshot(): BackgroundRuntimeSnapshot {
    const snapshot: BackgroundRuntimeSnapshot = {
      connection: this._attached ? "connected" : "disconnected",
      service: this._attached ? "running" : "stopped",
      memoryPolicy: this._memoryPolicy,
    };
    if (this._installed !== undefined) snapshot.launchAgentInstalled = this._installed;
    return snapshot;
  }

  _emit(snapshot: BackgroundRuntimeSnapshot): void {
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch {
        // A failing observer never changes runtime state.
      }
    }
  }
}

export = { BackgroundRuntimeUi, BackgroundRuntimeUiError, MEMORY_POLICIES };
