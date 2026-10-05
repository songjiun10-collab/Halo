"use strict";

// Task Branches (docs/superpowers/specs/2026-10-05-task-branches-design.md):
// while a parent's approval is pending, a branch reads independent pages in a
// separate, read-only browser surface so the user's wait is not idle time.
//
// This module is only the bookkeeping and the safety envelope. It never reads
// a page itself: an injected `runner` does, and the runner is handed the
// fixed `browse` policy mode, a signal and the budgets. The manager owns:
//   - what may start (https steps only, 1 branch per approval, 2 per task),
//   - how long it may run (step and wall-clock budgets, abort on resolution),
//   - what comes back (bounded, control-character-free, untrusted text),
//   - when it merges (only when the approval it waited on was granted).
// A branch has no way to approve, resolve or widen anything.

const crypto = require("node:crypto");

const BRANCH_POLICY_MODE = "browse";
const DEFAULTS = Object.freeze({
  maxPerApproval: 1,
  maxPerTask: 2,
  maxSteps: 12,
  maxMs: 5 * 60 * 1000,
  maxStepsOffered: 3,
  maxFindings: 6,
  maxFindingChars: 600,
  maxPurposeChars: 200,
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (value, max) => String(value ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

class TaskBranchManager {
  constructor({ runner, onEvent, onChange, now = () => Date.now(), ...limits } = {}) {
    if (typeof runner !== "function") throw new TypeError("TaskBranchManager requires a runner");
    this._runner = runner;
    this._onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this._onChange = typeof onChange === "function" ? onChange : () => {};
    this._now = now;
    this._limits = { ...DEFAULTS, ...limits };
    this._branches = new Map(); // id -> record
    this._merged = []; // findings handed to the parent, not yet consumed
    this._closed = false;
  }

  /** Validate the steps a planner offered; returns clean steps or []. */
  _cleanSteps(steps) {
    if (!Array.isArray(steps)) return [];
    const out = [];
    for (const step of steps.slice(0, this._limits.maxStepsOffered)) {
      const origin = originOf(step?.url);
      if (!origin) continue; // non-https, malformed, or a non-string url
      out.push({ url: new URL(step.url).href.slice(0, 2048), origin, purpose: clean(step.purpose, this._limits.maxPurposeChars) });
    }
    return out;
  }

  /**
   * Start a branch for a pending approval. Returns the public record, or null
   * when nothing may start (limits, no valid steps, or the manager is closed).
   */
  offer({ approvalId, steps, pendingOrigin = null }) {
    if (this._closed || typeof approvalId !== "string" || !approvalId) return null;
    const live = [...this._branches.values()].filter((b) => b.state === "running");
    if (live.some((b) => b.approvalId === approvalId)) return null;
    if ([...this._branches.values()].filter((b) => b.approvalId === approvalId).length >= this._limits.maxPerApproval) return null;
    if (live.length >= this._limits.maxPerTask) return null;
    // A branch never touches the page the approval is about.
    const cleaned = this._cleanSteps(steps).filter((step) => step.origin !== pendingOrigin);
    if (cleaned.length === 0) return null;

    const controller = new AbortController();
    const record = {
      id: crypto.randomUUID(),
      approvalId,
      steps: cleaned,
      state: "running", // running | done | failed | aborted | merged | discarded
      findings: [],
      startedAt: this._now(),
      controller,
      timer: null,
    };
    this._branches.set(record.id, record);
    this._onEvent("task_branch_started", { branchId: record.id, approvalId, steps: cleaned.map(({ url, purpose }) => ({ url, purpose })) });

    record.timer = setTimeout(() => this._abort(record, "time_budget"), this._limits.maxMs);
    record.timer.unref?.();
    let reported = 0;
    const report = (finding) => {
      if (record.state !== "running") return;
      reported += 1;
      if (reported > this._limits.maxSteps || record.findings.length >= this._limits.maxFindings) {
        this._abort(record, "step_budget");
        return;
      }
      const text = clean(finding?.text, this._limits.maxFindingChars);
      const url = typeof finding?.url === "string" && originOf(finding.url) ? new URL(finding.url).href.slice(0, 2048) : null;
      if (!text) return;
      record.findings.push({ url, origin: url ? new URL(url).origin : null, text });
      this._onChange();
    };
    Promise.resolve()
      .then(() => this._runner({
        branchId: record.id,
        steps: cleaned.map(({ url, purpose }) => ({ url, purpose })),
        policyMode: BRANCH_POLICY_MODE,
        budgets: { maxSteps: this._limits.maxSteps, maxMs: this._limits.maxMs },
        signal: controller.signal,
        report,
      }))
      .then(() => { if (record.state === "running") { record.state = "done"; } })
      .catch(() => { if (record.state === "running") { record.state = "failed"; } })
      .finally(() => { clearTimeout(record.timer); this._onChange(); });
    this._onChange();
    return this._public(record);
  }

  _abort(record, reason) {
    if (record.state !== "running") return;
    record.state = "aborted";
    record.abortReason = reason;
    clearTimeout(record.timer);
    record.controller.abort();
  }

  /**
   * The approval a branch waited on was settled. Granted: keep what was read
   * (and stop the rest) for the parent. Anything else: discard it all.
   */
  resolve(approvalId, outcome) {
    for (const record of this._branches.values()) {
      if (record.approvalId !== approvalId || record.state === "merged" || record.state === "discarded") continue;
      this._abort(record, "approval_resolved");
      if (outcome === "approved" && record.findings.length > 0) {
        record.state = "merged";
        for (const finding of record.findings) this._merged.push({ branchId: record.id, ...finding });
        this._onEvent("task_branch_merged", { branchId: record.id, approvalId, findings: record.findings.length });
      } else {
        record.state = "discarded";
        record.findings = [];
        this._onEvent("task_branch_discarded", { branchId: record.id, approvalId, outcome });
      }
    }
    this._onChange();
  }

  /**
   * Findings ready for the parent's next planner turn, as untrusted memory
   * entries. Each is returned exactly once.
   */
  takeMerged() {
    const taken = this._merged.splice(0);
    return taken.map((finding, index) => ({
      id: `branch-${finding.branchId}-${index}`,
      text: `Read while waiting for your approval${finding.url ? ` (${finding.url})` : ""}: ${finding.text}`,
      origin: finding.origin,
    }));
  }

  /** Task stop or shutdown: abort and discard every branch. */
  closeAll(outcome = "stopped") {
    this._closed = true;
    for (const record of this._branches.values()) {
      if (record.state === "merged" || record.state === "discarded") continue;
      this._abort(record, "closed");
      record.state = "discarded";
      record.findings = [];
      this._onEvent("task_branch_discarded", { branchId: record.id, approvalId: record.approvalId, outcome });
    }
    this._merged = [];
    this._onChange();
  }

  _public(record) {
    return {
      id: record.id,
      approvalId: record.approvalId,
      state: record.state,
      steps: record.steps.map(({ url, purpose }) => ({ url, purpose })),
      findings: record.findings.length,
      startedAt: record.startedAt,
    };
  }

  /** Snapshot-safe summaries (no findings text; that stays host-side). */
  list() {
    return [...this._branches.values()].map((record) => this._public(record));
  }
}

module.exports = { TaskBranchManager, BRANCH_POLICY_MODE, BRANCH_DEFAULTS: DEFAULTS };
