"use strict";

// P1 context manifest (docs/superpowers/specs/2026-10-02-claude-dev-harness-efficiency-design.md
// section 5). A per-task, in-memory, bounded catalog of host-owned reference
// bodies. The planner packet carries only manifest(); a context_read action
// reads bodies back through read(). Ref ids are opaque random tokens: read()
// never resolves a path, URL or anything outside this catalog.
//
// What goes in is the caller's responsibility: register only data the planner
// could already see (journal events, page-derived observations, evidence),
// never credentials or secrets. Authority labels travel with every result so
// page-derived text is never presented as host truth.

const crypto = require("node:crypto");

const LIMITS = Object.freeze({
  maxRefs: 128,
  maxRefsPerRead: 4,
  maxRefResultBytes: 4096,
  maxReadResultBytes: 12 * 1024,
  maxSummaryBytes: 256,
});
// A single body larger than this is refused at registration so the catalog
// stays bounded in memory (128 x 256 KiB worst case).
const MAX_BODY_BYTES = 256 * 1024;

const KINDS = Object.freeze(["events", "observation", "evidence"]);
const AUTHORITIES = Object.freeze(["host_journal", "host_evidence", "untrusted_page_derived"]);
const REF_ID_RE = /^ref_[A-Za-z0-9_-]{8,64}$/;

class ContextRefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContextRefError";
    this.code = code;
  }
}

function newRefId() {
  return `ref_${crypto.randomBytes(12).toString("base64url")}`;
}

// Largest end <= limit that does not split a UTF-8 sequence.
function utf8Boundary(buffer, start, limit) {
  let end = Math.min(limit, buffer.length);
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

function boundedSummary(text) {
  const buffer = Buffer.from(String(text), "utf8");
  if (buffer.length <= LIMITS.maxSummaryBytes) return buffer.toString("utf8");
  return buffer.subarray(0, utf8Boundary(buffer, 0, LIMITS.maxSummaryBytes)).toString("utf8");
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

class ContextRefCatalog {
  constructor({ taskId, maxRefs = LIMITS.maxRefs } = {}) {
    if (typeof taskId !== "string" || taskId.length === 0) throw new ContextRefError("invalid_config", "taskId is required");
    if (!Number.isInteger(maxRefs) || maxRefs < 1 || maxRefs > LIMITS.maxRefs) throw new ContextRefError("invalid_config", `maxRefs must be 1..${LIMITS.maxRefs}`);
    this._taskId = taskId;
    this._maxRefs = maxRefs;
    this._refs = new Map(); // refId -> entry, insertion order = age
    this._continuations = new Map(); // continuationRefId -> { parentId, offset }
  }

  register({ kind, authority, body, summary = "", goalVersion, documentEpoch = null }) {
    if (!KINDS.includes(kind)) throw new ContextRefError("invalid_field", `kind must be one of ${KINDS.join("|")}`);
    if (!AUTHORITIES.includes(authority)) throw new ContextRefError("invalid_field", `authority must be one of ${AUTHORITIES.join("|")}`);
    if (!Number.isInteger(goalVersion) || goalVersion < 0) throw new ContextRefError("invalid_field", "goalVersion must be a non-negative integer");
    if (documentEpoch !== null && (!Number.isInteger(documentEpoch) || documentEpoch < 0)) throw new ContextRefError("invalid_field", "documentEpoch must be null or a non-negative integer");
    const serialized = JSON.stringify(body);
    if (typeof serialized !== "string") throw new ContextRefError("invalid_field", "body must be JSON-serializable");
    const buffer = Buffer.from(serialized, "utf8");
    if (buffer.length > MAX_BODY_BYTES) throw new ContextRefError("field_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);

    while (this._refs.size >= this._maxRefs) this._evict(this._refs.keys().next().value);
    const refId = newRefId();
    this._refs.set(refId, {
      kind,
      authority,
      buffer,
      summary: boundedSummary(summary),
      goalVersion,
      documentEpoch,
      revision: `g${goalVersion}.e${documentEpoch ?? "-"}`,
    });
    return refId;
  }

  manifest() {
    return {
      version: 1,
      refs: [...this._refs].map(([refId, e]) => ({ refId, kind: e.kind, authority: e.authority, revision: e.revision, byteLength: e.buffer.length, summary: e.summary })),
    };
  }

  revoke(refId) {
    this._evict(refId);
  }

  clear() {
    this._refs.clear();
    this._continuations.clear();
  }

  read(refIds, { taskId, goalVersion, documentEpoch = null } = {}) {
    if (!Array.isArray(refIds) || refIds.length === 0) throw new ContextRefError("invalid_field", "context_read needs at least one ref id");
    if (refIds.length > LIMITS.maxRefsPerRead) throw new ContextRefError("field_too_large", `context_read takes at most ${LIMITS.maxRefsPerRead} ref ids`);
    if (refIds.some((id) => typeof id !== "string" || !REF_ID_RE.test(id))) throw new ContextRefError("invalid_field", "every ref id must be an opaque ref id from the manifest");
    if (new Set(refIds).size !== refIds.length) throw new ContextRefError("invalid_field", "context_read ref ids must not contain duplicates");

    const out = { authority: "context_read", truncated: false, results: [] };
    // Reserve room for the error entries of refs not yet answered so every
    // requested ref always gets an answer inside the set bound.
    const errorBytes = (refId, code) => jsonBytes({ refId, outcome: "error", code }) + 1;
    for (const [index, refId] of refIds.entries()) {
      const reserved = refIds.slice(index + 1).reduce((sum, id) => sum + errorBytes(id, "context_read_budget"), 0);
      const room = LIMITS.maxReadResultBytes - jsonBytes(out) - 1 - reserved;
      const result = this._readOne(refId, { taskId, goalVersion, documentEpoch }, Math.min(LIMITS.maxRefResultBytes, room));
      if (result.truncated || result.code === "context_read_budget") out.truncated = true;
      out.results.push(result);
    }
    return out;
  }

  _readOne(refId, scope, budget) {
    const error = (code) => ({ refId, outcome: "error", code });
    if (scope.taskId !== this._taskId) return error("context_ref_forbidden");
    let parentId = refId;
    let offset = 0;
    if (this._continuations.has(refId)) ({ parentId, offset } = this._continuations.get(refId));
    const entry = this._refs.get(parentId);
    if (!entry) return error("context_ref_unavailable");
    if (entry.goalVersion !== scope.goalVersion) return error("context_ref_stale");
    // A ref bound to a live document goes stale with it; a historical
    // snapshot (registered with documentEpoch null) is only bound to the goal.
    if (entry.authority === "untrusted_page_derived" && entry.documentEpoch !== null && entry.documentEpoch !== scope.documentEpoch) return error("context_ref_stale");

    const base = { refId, outcome: "ok", kind: entry.kind, authority: entry.authority };
    const rest = entry.buffer.subarray(offset).toString("utf8");
    const whole = { ...base, truncated: false, body: rest };
    if (jsonBytes(whole) <= budget) return whole;

    const continuationRefId = newRefId();
    let end = utf8Boundary(entry.buffer, offset, offset + Math.max(0, budget - jsonBytes({ ...base, truncated: true, continuationRefId, body: "" })));
    let candidate = null;
    while (end > offset) {
      candidate = { ...base, truncated: true, continuationRefId, body: entry.buffer.subarray(offset, end).toString("utf8") };
      const excess = jsonBytes(candidate) - budget;
      if (excess <= 0) break;
      candidate = null;
      end = utf8Boundary(entry.buffer, offset, end - Math.max(4, excess));
    }
    if (!candidate) return error("context_read_budget");
    // Oldest continuation goes first; reading it later is context_ref_unavailable.
    while (this._continuations.size >= this._maxRefs * 4) this._continuations.delete(this._continuations.keys().next().value);
    this._continuations.set(continuationRefId, { parentId, offset: end });
    return candidate;
  }

  _evict(refId) {
    this._refs.delete(refId);
    for (const [id, c] of this._continuations) if (c.parentId === refId) this._continuations.delete(id);
  }
}

module.exports = { ContextRefCatalog, ContextRefError, LIMITS, KINDS, AUTHORITIES, MAX_BODY_BYTES, REF_ID_RE };
