"use strict";

// In-team communication guard: wait-for graph (deadlock refusal), per-sender
// open-question and send-rate limits, and question timeouts. Pure and
// in-memory; the coordinator owns one per team and consults it before
// admitting question/answer/share/claim traffic.

class CommsGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommsGuardError";
    this.code = code;
  }
}

class CommsGuard {
  constructor({ maxOpenQuestions = 3, questionTimeoutMs = 120000, maxSends = 20, sendWindowMs = 60000, now = () => Date.now() } = {}) {
    this._maxOpen = maxOpenQuestions;
    this._timeout = questionTimeoutMs;
    this._maxSends = maxSends;
    this._window = sendWindowMs;
    this._now = now;
    this._questions = new Map(); // id -> {id, from, to, at}
    this._sends = new Map(); // sender -> timestamps
  }

  waitingOn(taskId) {
    const out = [];
    for (const q of this._questions.values()) if (q.from === taskId) out.push(q.to);
    return out;
  }

  _reaches(start, target, seen = new Set()) {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    return this.waitingOn(start).some((next) => this._reaches(next, target, seen));
  }

  noteQuestion({ id, from, to }) {
    if (this._questions.has(id)) return;
    if (from === to || this._reaches(to, from)) {
      throw new CommsGuardError("deadlock", `question ${from}->${to} would close a wait cycle`);
    }
    if (this.waitingOn(from).length >= this._maxOpen) {
      throw new CommsGuardError("wait_limit", `${from} already has ${this._maxOpen} open questions`);
    }
    this._questions.set(id, { id, from, to, at: this._now() });
  }

  noteAnswer(id) {
    return this._questions.delete(id);
  }

  // An answer from `answerer` closes the oldest question `asker` put to it.
  noteAnswerBetween(asker, answerer) {
    for (const q of this._questions.values()) {
      if (q.from === asker && q.to === answerer) return this._questions.delete(q.id);
    }
    return false;
  }

  expireQuestions() {
    const now = this._now();
    const expired = [];
    for (const q of this._questions.values()) if (now - q.at >= this._timeout) expired.push(q);
    for (const q of expired) this._questions.delete(q.id);
    return expired;
  }

  checkSend(sender) {
    const now = this._now();
    const recent = (this._sends.get(sender) || []).filter((at) => now - at < this._window);
    if (recent.length >= this._maxSends) {
      this._sends.set(sender, recent);
      throw new CommsGuardError("send_limit", `${sender} exceeded ${this._maxSends} sends per window`);
    }
    recent.push(now);
    this._sends.set(sender, recent);
  }

  broadcastTargets(sender, teamTaskIds) {
    return teamTaskIds.filter((id) => id !== sender);
  }
}

module.exports = { CommsGuard, CommsGuardError };
