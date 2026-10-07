"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { diffSnapshots, verifyEffect, parseSnapshot } = require("../main/harness/effect-verifier");

const base = { url: "https://a.test/", title: "A", nodes: 10, textLength: 100, focus: "INPUT#q", valueLength: 3 };

test("an already-visible effect is verified without a polling delay", async () => {
  const slept = [];
  const result = await verifyEffect({ before: base, read: async () => ({ ...base, title: "Changed" }), sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(result, { observed: true, changed: ["title"] });
  assert.deepEqual(slept, []);
});

test("an immediate unreadable snapshot still preserves the full polling window", async () => {
  let elapsed = 0;
  const at = [];
  const result = await verifyEffect({ before: base,
    read: async () => { at.push(elapsed); return elapsed === 300 ? { ...base, title: "Changed" } : null; },
    sleep: async (ms) => { elapsed += ms; }, timeoutMs: 300, intervalMs: 100 });
  assert.deepEqual(result, { observed: true, changed: ["title"] });
  assert.deepEqual(at, [0, 100, 200, 300]);
});

test("a rejected immediate read cannot report success or shorten subsequent polling", async () => {
  let elapsed = 0;
  const at = [];
  const result = await verifyEffect({ before: base,
    read: async () => { at.push(elapsed); if (elapsed === 0) throw new Error("page unavailable"); return base; },
    sleep: async (ms) => { elapsed += ms; }, timeoutMs: 300, intervalMs: 100 });
  assert.deepEqual(result, { observed: false, changed: [] });
  assert.deepEqual(at, [0, 100, 200, 300]);
  assert.equal(elapsed, 300);
});

test("diffSnapshots names exactly the fields that changed", () => {
  assert.deepEqual(diffSnapshots(base, { ...base }), []);
  assert.deepEqual(diffSnapshots(base, { ...base, valueLength: 0 }), ["valueLength"]);
  assert.deepEqual(diffSnapshots(base, { ...base, url: "https://a.test/r", title: "R" }), ["url", "title"]);
});

test("verifyEffect returns observed as soon as the page changes", async () => {
  const reads = [base, base, { ...base, valueLength: 0 }];
  const slept = [];
  const result = await verifyEffect({ before: base, read: async () => reads.shift() ?? base, sleep: async (ms) => { slept.push(ms); }, timeoutMs: 1000, intervalMs: 100 });
  assert.deepEqual(result, { observed: true, changed: ["valueLength"] });
  assert.equal(slept.length, 2);
});

test("verifyEffect reports not observed after the timeout when nothing changes", async () => {
  let reads = 0;
  const result = await verifyEffect({ before: base, read: async () => { reads += 1; return base; }, sleep: async () => {}, timeoutMs: 500, intervalMs: 100 });
  assert.deepEqual(result, { observed: false, changed: [] });
  assert.equal(reads, 6);
});

test("an unreadable page counts as a change only when it was readable before and now has a different url", async () => {
  const result = await verifyEffect({ before: base, read: async () => null, sleep: async () => {}, timeoutMs: 200, intervalMs: 100 });
  assert.equal(result.observed, false);
});

test("parseSnapshot accepts the page script's JSON and rejects anything else", () => {
  assert.deepEqual(parseSnapshot(JSON.stringify(base)), base);
  assert.equal(parseSnapshot("not json"), null);
  assert.equal(parseSnapshot(JSON.stringify({ url: 1 })), null);
  assert.equal(parseSnapshot(undefined), null);
});
