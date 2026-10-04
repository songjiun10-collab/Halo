"use strict";

// P1 (docs/superpowers/specs/2026-10-02-claude-dev-harness-efficiency-design.md
// section 5): a per-task, bounded catalog of host-owned references. The packet
// carries only a manifest (id, kind, authority, revision, size, short summary);
// the planner reads bodies on demand with a context_read action. Reads are
// bounded per ref and per set, never resolve a path or URL, and fail closed
// with a distinct code for missing, foreign and stale refs.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ContextRefCatalog, LIMITS } = require("../main/harness/context-refs");

const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const scope = { taskId: TASK, goalVersion: 1, documentEpoch: 3 };

function catalog(options = {}) {
  return new ContextRefCatalog({ taskId: TASK, ...options });
}

test("limits match the design draft", () => {
  assert.deepEqual(LIMITS, { maxRefs: 128, maxRefsPerRead: 4, maxRefResultBytes: 4096, maxReadResultBytes: 12 * 1024, maxSummaryBytes: 256 });
});

test("register returns an opaque id and the manifest describes refs without their bodies", () => {
  const c = catalog();
  const id = c.register({ kind: "events", authority: "host_journal", body: { events: ["a", "b"] }, summary: "older events", goalVersion: 1, documentEpoch: 3 });
  assert.match(id, /^ref_[A-Za-z0-9_-]{8,}$/);
  const manifest = c.manifest();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.refs.length, 1);
  const [ref] = manifest.refs;
  assert.deepEqual(Object.keys(ref).sort(), ["authority", "byteLength", "kind", "refId", "revision", "summary"]);
  assert.equal(ref.byteLength, Buffer.byteLength(JSON.stringify({ events: ["a", "b"] }), "utf8"));
  assert.equal(JSON.stringify(manifest).includes("\"a\""), false, "bodies never enter the manifest");
});

test("summaries are bounded on a UTF-8 boundary and kinds/authorities are closed", () => {
  const c = catalog();
  c.register({ kind: "observation", authority: "untrusted_page_derived", body: "x", summary: "가".repeat(200), goalVersion: 1, documentEpoch: 3 });
  const summary = c.manifest().refs[0].summary;
  assert.ok(Buffer.byteLength(summary, "utf8") <= LIMITS.maxSummaryBytes);
  assert.equal(summary.includes("�"), false);
  assert.throws(() => c.register({ kind: "file", authority: "host_journal", body: "x", summary: "", goalVersion: 1, documentEpoch: 3 }), /kind/);
  assert.throws(() => c.register({ kind: "events", authority: "trusted", body: "x", summary: "", goalVersion: 1, documentEpoch: 3 }), /authority/);
});

test("read returns bodies with their authority and charges nothing itself", () => {
  const c = catalog();
  const id = c.register({ kind: "events", authority: "host_journal", body: { n: 1 }, summary: "s", goalVersion: 1, documentEpoch: 3 });
  const result = c.read([id], scope);
  assert.deepEqual(result, { authority: "context_read", truncated: false, results: [{ refId: id, outcome: "ok", kind: "events", authority: "host_journal", truncated: false, body: JSON.stringify({ n: 1 }) }] });
});

test("missing, foreign and stale refs fail closed with distinct codes", () => {
  const c = catalog();
  const old = c.register({ kind: "observation", authority: "untrusted_page_derived", body: "old page", summary: "", goalVersion: 1, documentEpoch: 2 });
  const prior = c.register({ kind: "events", authority: "host_journal", body: "v0", summary: "", goalVersion: 0, documentEpoch: 3 });
  const out = c.read(["ref_doesnotexist0", old, prior], scope).results.map((r) => [r.outcome, r.code]);
  assert.deepEqual(out, [["error", "context_ref_unavailable"], ["error", "context_ref_stale"], ["error", "context_ref_stale"]]);
  assert.deepEqual(c.read([old], { ...scope, taskId: OTHER }).results.map((r) => r.code), ["context_ref_forbidden"]);
  for (const r of c.read(["ref_doesnotexist0"], scope).results) assert.equal(Object.hasOwn(r, "body"), false, "absence is never an empty success");
});

test("host-journal refs survive a new page; page-derived refs do not", () => {
  const c = catalog();
  const events = c.register({ kind: "events", authority: "host_journal", body: "e", summary: "", goalVersion: 1, documentEpoch: 1 });
  assert.equal(c.read([events], scope).results[0].outcome, "ok");
});

test("read takes at most four distinct, well-formed ref ids", () => {
  const c = catalog();
  const ids = [1, 2, 3, 4, 5].map((n) => c.register({ kind: "events", authority: "host_journal", body: n, summary: "", goalVersion: 1, documentEpoch: 3 }));
  assert.throws(() => c.read(ids, scope), /at most 4/);
  assert.throws(() => c.read([], scope), /at least one/);
  assert.throws(() => c.read([ids[0], ids[0]], scope), /duplicate/);
  assert.throws(() => c.read(["../../etc/passwd"], scope), /ref id/);
  assert.throws(() => c.read(["https://example.com"], scope), /ref id/);
});

test("a long body is cut on a UTF-8 boundary with a continuation ref that reads on", () => {
  const c = catalog();
  const body = "한".repeat(3000); // 9000 bytes
  const id = c.register({ kind: "observation", authority: "untrusted_page_derived", body, summary: "", goalVersion: 1, documentEpoch: 3 });
  const parts = [];
  let next = id;
  for (let guard = 0; next && guard < 10; guard += 1) {
    const read = c.read([next], scope);
    assert.ok(Buffer.byteLength(JSON.stringify(read.results[0]), "utf8") <= LIMITS.maxRefResultBytes);
    const [r] = read.results;
    assert.equal(r.body.includes("�"), false);
    parts.push(r.body);
    next = r.truncated ? r.continuationRefId : null;
  }
  assert.ok(parts.length >= 3);
  assert.equal(parts.join(""), JSON.stringify(body), "continuations reassemble the exact serialized body");
});

test("the whole result set stays within 12 KiB, cutting later refs rather than failing", () => {
  const c = catalog();
  const ids = [0, 1, 2, 3].map(() => c.register({ kind: "events", authority: "host_journal", body: "z".repeat(5000), summary: "", goalVersion: 1, documentEpoch: 3 }));
  const read = c.read(ids, scope);
  assert.ok(Buffer.byteLength(JSON.stringify(read), "utf8") <= LIMITS.maxReadResultBytes);
  assert.equal(read.results.length, 4, "every requested ref is answered");
  assert.equal(read.truncated, true);
  assert.equal(read.results.at(-1).code, "context_read_budget", "a ref that no longer fits is reported, not dropped");
});

test("the catalog is bounded: the oldest ref is evicted and then reads as unavailable", () => {
  const c = catalog({ maxRefs: 2 });
  const first = c.register({ kind: "events", authority: "host_journal", body: 1, summary: "", goalVersion: 1, documentEpoch: 3 });
  c.register({ kind: "events", authority: "host_journal", body: 2, summary: "", goalVersion: 1, documentEpoch: 3 });
  c.register({ kind: "events", authority: "host_journal", body: 3, summary: "", goalVersion: 1, documentEpoch: 3 });
  assert.equal(c.manifest().refs.length, 2);
  assert.equal(c.read([first], scope).results[0].code, "context_ref_unavailable");
});

test("clear() revokes every ref, including continuations", () => {
  const c = catalog();
  const id = c.register({ kind: "events", authority: "host_journal", body: "y".repeat(6000), summary: "", goalVersion: 1, documentEpoch: 3 });
  const cont = c.read([id], scope).results[0].continuationRefId;
  c.clear();
  assert.deepEqual(c.manifest().refs, []);
  assert.deepEqual(c.read([id, cont], scope).results.map((r) => r.code), ["context_ref_unavailable", "context_ref_unavailable"]);
});

test("continuation ids are bounded too: repeated reads never grow memory without limit", () => {
  const c = catalog();
  const id = c.register({ kind: "events", authority: "host_journal", body: "w".repeat(20000), summary: "", goalVersion: 1, documentEpoch: 3 });
  for (let i = 0; i < 2000; i += 1) c.read([id], scope);
  assert.ok(c._continuations.size <= LIMITS.maxRefs * 4);
});

test("a historical page snapshot (no live document) is bound to the goal, not the page", () => {
  const c = catalog();
  const id = c.register({ kind: "observation", authority: "untrusted_page_derived", body: { url: "u", text: "t" }, summary: "", goalVersion: 1 });
  assert.equal(c.read([id], { ...scope, documentEpoch: 99 }).results[0].outcome, "ok");
  assert.equal(c.read([id], { ...scope, goalVersion: 2 }).results[0].code, "context_ref_stale");
});
