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

const MEMORY_POLICIES = Object.freeze(["budgeted", "user_override"]);

class BackgroundRuntimeUiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackgroundRuntimeUiError";
    this.code = code;
  }
}

const isRuntimeClient = (host) => typeof host?.stopService === "function" && typeof host?.detach === "function";

class BackgroundRuntimeUi {
  // launchAgentInstalled: optional async () => boolean (LaunchAgentManager.
  // isInstalled bound to this app's label). Left out of the snapshot when
  // absent or failing: unknown is not "not installed".
  // launchAgent: optional {isInstalled, enable, disable}
  // (background-launch-agent.js); it also answers launchAgentInstalled and
  // makes setLaunchAtLogin available.
  constructor({ host, launchAgentInstalled, launchAgent } = {}) {
    if (launchAgentInstalled !== undefined && typeof launchAgentInstalled !== "function") {
      throw new BackgroundRuntimeUiError("invalid_config", "launchAgentInstalled must be a function");
    }
    if (launchAgent !== undefined && launchAgent !== null && !["isInstalled", "enable", "disable"].every((name) => typeof launchAgent[name] === "function")) {
      throw new BackgroundRuntimeUiError("invalid_config", "launchAgent needs isInstalled, enable and disable");
    }
    this._launchAgent = launchAgent ?? null;
    this._launchAgentInstalled = launchAgentInstalled ?? (this._launchAgent ? () => this._launchAgent.isInstalled() : null);
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

  async getSnapshot() {
    await this._refreshInstalled();
    // A stopped service's client is closed; its last known policy stands.
    if (this._stopped) return this._snapshot();
    try {
      const settings = await this._host.getHostSettings();
      if (MEMORY_POLICIES.includes(settings?.memoryPolicy)) this._memoryPolicy = settings.memoryPolicy;
    } catch (error) {
      // A local host failing to read its settings is a real error; a remote
      // one keeps the last known policy and reports the connection instead.
      if (!this._attached) throw error;
    }
    return this._snapshot();
  }

  // Re-reads and pushes this window's snapshot, e.g. after another window
  // changed the shared memory policy. Never throws.
  async refresh() {
    try {
      this._emit(await this.getSnapshot());
    } catch {
      // A local host that cannot read its settings keeps its last push.
    }
  }

  async attach() {
    return this.getSnapshot();
  }

  async detach() {
    throw new BackgroundRuntimeUiError("detach_unsupported", "close the window to detach it from the background service");
  }

  async setMemoryPolicy(mode) {
    if (!MEMORY_POLICIES.includes(mode)) {
      throw new BackgroundRuntimeUiError("invalid_memory_policy", `memoryPolicy must be one of ${MEMORY_POLICIES.join("|")}`);
    }
    const settings = await this._host.updateHostSettings({ memoryPolicy: mode });
    this._memoryPolicy = MEMORY_POLICIES.includes(settings?.memoryPolicy) ? settings.memoryPolicy : mode;
    const snapshot = this._snapshot();
    this._emit(snapshot);
    return snapshot;
  }

  async stopService() {
    if (!this._attached) {
      throw new BackgroundRuntimeUiError("no_background_service", "this window is not attached to a background service");
    }
    await this._host.stopService("user_stop");
    // The client may not see its own serviceStopping broadcast before the
    // socket closes, so mark the service gone here as well (idempotent).
    this._serviceGone();
    return this._snapshot();
  }

  // Explicit user toggle: install-and-load or unload-and-remove the
  // background service's LaunchAgent.
  async setLaunchAtLogin(enabled) {
    if (typeof enabled !== "boolean") {
      throw new BackgroundRuntimeUiError("invalid_launch_at_login", "enabled must be true or false");
    }
    if (!this._launchAgent) {
      throw new BackgroundRuntimeUiError("launch_agent_unavailable", "starting at login is not available here");
    }
    await (enabled ? this._launchAgent.enable() : this._launchAgent.disable());
    await this._refreshInstalled();
    const snapshot = this._snapshot();
    this._emit(snapshot);
    return snapshot;
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("onChange requires a listener function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _serviceGone() {
    if (!this._attached) return;
    this._attached = false;
    this._stopped = true;
    this._emit(this._snapshot());
  }

  async _refreshInstalled() {
    if (!this._launchAgentInstalled) return;
    try {
      const installed = await this._launchAgentInstalled();
      this._installed = typeof installed === "boolean" ? installed : undefined;
    } catch {
      this._installed = undefined;
    }
  }

  _snapshot() {
    const snapshot = {
      connection: this._attached ? "connected" : "disconnected",
      service: this._attached ? "running" : "stopped",
      memoryPolicy: this._memoryPolicy,
    };
    if (this._installed !== undefined) snapshot.launchAgentInstalled = this._installed;
    return snapshot;
  }

  _emit(snapshot) {
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch {
        // A failing observer never changes runtime state.
      }
    }
  }
}

module.exports = { BackgroundRuntimeUi, BackgroundRuntimeUiError, MEMORY_POLICIES };
