"use strict";

// Human handoff: a structured record for a task that is waiting on a person.
// TaskController already pauses the task (state "paused" + pauseReason); this
// module adds the in-memory waiting queue behind listHandoffs(), one
// notification per wait, and the shape of the durable journal notes the host
// writes. It never resumes, retries, or expires a wait by itself -- only an
// explicit human action (resume/stop/take-over) clears a handoff, so a
// challenged or uncertain task is never pumped back into the site unattended.

const HUMAN_REASONS = Object.freeze(["captcha", "need_user", "execution_uncertain"]);
const REASON_LABELS = Object.freeze({
  captcha: "Pass the human check in the browser, then resume.",
  need_user: "The task asked you a question.",
  execution_uncertain: "An action was interrupted; review before resuming.",
});
const MAX_DETAIL_CHARS = 500;

function needsHuman(pauseReason) {
  return typeof pauseReason === "string" && HUMAN_REASONS.includes(pauseReason);
}

function handoffLabel(pauseReason) {
  return REASON_LABELS[pauseReason] ?? "This task needs you.";
}

class HumanHandoffQueue {
  constructor({ notify = null, now = () => Date.now() } = {}) {
    this._notify = typeof notify === "function" ? notify : null;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._waiting = new Map();
  }

  // Opens (or keeps) a wait. Returns { record, created }. A repeated pause
  // with the same reason is idempotent: the wait keeps its original "since"
  // and the person is not notified twice. A new reason restarts the wait.
  open({ taskId, reason, detail = null } = {}) {
    if (typeof taskId !== "string" || taskId.length === 0 || !needsHuman(reason)) return null;
    const existing = this._waiting.get(taskId);
    if (existing && existing.reason === reason) return { record: { ...existing }, created: false };
    const record = {
      taskId,
      reason,
      label: handoffLabel(reason),
      detail: typeof detail === "string" && detail.length > 0 ? detail.slice(0, MAX_DETAIL_CHARS) : null,
      since: this._now(),
    };
    this._waiting.set(taskId, record);
    if (this._notify) {
      try {
        this._notify({ ...record });
      } catch {
        // A failed notification must never break the pause that opened it.
      }
    }
    return { record: { ...record }, created: true };
  }

  // Ends the wait. Returns the resolved record, or null when none was open.
  resolve(taskId, { outcome = "resumed" } = {}) {
    const existing = this._waiting.get(taskId);
    if (!existing) return null;
    this._waiting.delete(taskId);
    return {
      ...existing,
      outcome: typeof outcome === "string" && outcome.length > 0 ? outcome : "resumed",
      resolvedAt: this._now(),
    };
  }

  get(taskId) {
    const record = this._waiting.get(taskId);
    return record ? { ...record } : null;
  }

  has(taskId) {
    return this._waiting.has(taskId);
  }

  list() {
    return [...this._waiting.values()].map((record) => ({ ...record }));
  }

  get size() {
    return this._waiting.size;
  }
}

module.exports = { HUMAN_REASONS, HumanHandoffQueue, handoffLabel, needsHuman };
