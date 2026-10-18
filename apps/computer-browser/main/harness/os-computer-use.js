"use strict";

// Drives a native app through an OsBackend (screen + accessibility on the real Mac, a fake in tests).
// Every action is judged by os-policy before the backend hears about it: a refused action never reaches
// the backend, an "ask" action runs only when the caller's approve() says yes, and each action is
// journalled before it runs. Observations are single-use views: the point of a click is a fraction of the
// window as it was observed, so a different or moved window makes the observation stale.

const { randomUUID } = require("node:crypto");
const policy = require("./os-policy");

const MAX_TYPE_CHARS = 2000;
const unit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1;

class OsComputerUse {
  // backend: { observe(), click(x, y), typeText(text), pressKey(key) }
  constructor({ backend, allowedApps = [], maxActions, approve = async () => false, journal = async () => {} } = {}) {
    if (!backend || typeof backend.observe !== "function") throw new TypeError("backend is required");
    this._backend = backend;
    this._allowedApps = Object.freeze([...allowedApps]);
    this._maxActions = maxActions;
    this._approve = approve;
    this._journal = journal;
    this._observation = null;
    this._used = 0;
    this._stopped = false;
  }

  // The person's stop: from now on nothing is observed or driven. There is no way to undo it on this object.
  stop() { this._stopped = true; this._observation = null; }
  get stopped() { return this._stopped; }

  get actionsUsed() { return this._used; }

  _options() { return { allowedApps: this._allowedApps, maxActions: this._maxActions, actionsUsed: this._used }; }

  // The planner sees names and titles as data from another app, never as instructions.
  async observe() {
    if (this._stopped) return { status: "failed", errorCode: "os_stopped" };
    const raw = await this._backend.observe();
    const verdict = policy.windowDecision(raw?.window, this._options());
    if (verdict.gate !== "auto") {
      this._observation = null;
      return { status: "failed", errorCode: "os_denied", reason: verdict.reason };
    }
    const id = randomUUID();
    this._observation = { id, window: { ...raw.window }, controls: Array.isArray(raw.controls) ? raw.controls.map((c) => ({ ...c })) : [] };
    return {
      status: "ok",
      observation: { id, authority: "untrusted_page_derived", window: { app: raw.window.app, bundleId: raw.window.bundleId, title: raw.window.title }, controls: this._observation.controls },
    };
  }

  _hit(x, y) {
    let best = null;
    for (const c of this._observation.controls) {
      if (x < c.x || x > c.x + c.w || y < c.y || y > c.y + c.h) continue;
      if (!best || c.w * c.h < best.w * best.h) best = c;
    }
    return best;
  }

  async execute(action) {
    if (this._stopped) return { status: "failed", errorCode: "os_stopped" };
    const obs = this._observation;
    if (!obs || action?.observationId !== obs.id) return { status: "failed", errorCode: "stale_os_observation" };
    // The window the person has in front now must still be the one that was observed.
    const front = await this._backend.observe();
    if (front?.window?.bundleId !== obs.window.bundleId || front?.window?.pid !== obs.window.pid || front?.window?.title !== obs.window.title) {
      this._observation = null;
      return { status: "failed", errorCode: "stale_os_observation" };
    }
    let decision;
    let run;
    switch (action.type) {
      case "os_click_at": {
        if (!unit(action.x) || !unit(action.y)) return { status: "failed", errorCode: "invalid_os_action" };
        decision = policy.clickDecision(obs.window, this._hit(action.x, action.y), this._options());
        run = () => this._backend.click(action.x, action.y);
        break;
      }
      case "os_type_text": {
        if (typeof action.text !== "string" || action.text.length === 0 || action.text.length > MAX_TYPE_CHARS) return { status: "failed", errorCode: "invalid_os_action" };
        decision = policy.typeDecision(obs.window, obs.controls.find((c) => c.focused) ?? null, this._options(), action.text);
        run = () => this._backend.typeText(action.text);
        break;
      }
      case "os_press_key": {
        decision = policy.keyDecision(obs.window, action.key, this._options());
        run = () => this._backend.pressKey(action.key);
        break;
      }
      default:
        return { status: "failed", errorCode: "unsupported_action" };
    }
    if (decision.gate === "deny") return { status: "failed", errorCode: "os_denied", reason: decision.reason };
    if (decision.gate === "ask" && (await this._approve({ action, reason: decision.reason, window: obs.window })) !== true) {
      return { status: "needs_approval", errorCode: "os_needs_approval", reason: decision.reason };
    }
    // Journal first, then act, and spend the observation: a lost result must never replay the action.
    await this._journal({ type: action.type, observationId: obs.id, bundleId: obs.window.bundleId, gate: decision.gate });
    this._observation = null;
    this._used += 1;
    try {
      await run();
    } catch (error) {
      if (error?.code === "user_interrupted") { this.stop(); return { status: "failed", errorCode: "os_stopped", reason: "the person took over the mouse or keyboard" }; }
      return { status: "uncertain", errorCode: "os_backend_threw" };
    }
    return { status: "ok" };
  }
}

// A deterministic backend for tests: a fixed window and controls, with every call recorded.
class FakeOsBackend {
  constructor({ window, controls = [] }) {
    this.window = window;
    this.controls = controls;
    this.calls = [];
  }
  async observe() { return { window: { ...this.window }, controls: this.controls.map((c) => ({ ...c })) }; }
  async click(x, y) { this.calls.push(["click", x, y]); }
  async typeText(text) { this.calls.push(["type", text]); }
  async pressKey(key) { this.calls.push(["key", key]); }
}

module.exports = { OsComputerUse, FakeOsBackend };
