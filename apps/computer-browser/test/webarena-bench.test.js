"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarRecorder, MAX_BODY_BYTES } = require("../integration/webarena/har");
const { buildAgentResponse } = require("../integration/webarena/response");

test("HAR recorder pairs a request with its completion and keeps method, url, status and body", () => {
  let t = 1000;
  const rec = createHarRecorder({ now: () => (t += 5) });
  rec.onBeforeRequest({ id: 1, method: "POST", url: "http://shop/cart", uploadData: [{ bytes: Buffer.from("a=1") }] });
  rec.onCompleted({ id: 1, statusCode: 302 });
  const [entry] = rec.toHar().log.entries;
  assert.equal(entry.request.method, "POST");
  assert.equal(entry.request.postData.text, "a=1");
  assert.equal(entry.response.status, 302);
  assert.equal(rec.toHar().log.version, "1.2");
});

test("HAR recorder records failed requests as status 0 and ignores unknown completions", () => {
  const rec = createHarRecorder();
  rec.onBeforeRequest({ id: 2, method: "GET", url: "http://shop/x" });
  rec.onErrorOccurred({ id: 2 });
  rec.onCompleted({ id: 99, statusCode: 200 });
  assert.equal(rec.size, 1);
  assert.equal(rec.toHar().log.entries[0].response.status, 0);
});

test("HAR recorder drops oversized request bodies instead of storing them", () => {
  const rec = createHarRecorder();
  rec.onBeforeRequest({ id: 3, method: "POST", url: "http://shop/up", uploadData: [{ bytes: Buffer.alloc(MAX_BODY_BYTES + 1) }] });
  rec.onCompleted({ id: 3, statusCode: 200 });
  assert.equal(rec.toHar().log.entries[0].request.postData, undefined);
});

test("only an agent-declared finish is SUCCESS; everything else is an error status", () => {
  assert.equal(buildAgentResponse({ taskType: "NAVIGATE", state: "completed" }).status, "SUCCESS");
  assert.equal(buildAgentResponse({ taskType: "MUTATE", state: "awaiting_verification" }).status, "SUCCESS");
  for (const state of ["stopped", "failed", "running"]) assert.equal(buildAgentResponse({ taskType: "MUTATE", state }).status, "UNKNOWN_ERROR");
  assert.equal(buildAgentResponse({ taskType: "MUTATE", state: "completed", timedOut: true }).status, "UNKNOWN_ERROR");
  assert.equal(buildAgentResponse({ taskType: "NAVIGATE", state: "paused", pauseReason: "need_user" }).status, "UNKNOWN_ERROR");
});

test("RETRIEVE needs an extracted answer array", () => {
  assert.equal(buildAgentResponse({ taskType: "RETRIEVE", state: "completed" }).status, "NOT_FOUND_ERROR");
  const ok = buildAgentResponse({ taskType: "RETRIEVE", state: "completed", answer: ["42"] });
  assert.deepEqual([ok.status, ok.retrieved_data, ok.error_details], ["SUCCESS", ["42"], null]);
  assert.throws(() => buildAgentResponse({ taskType: "WRITE", state: "completed" }), RangeError);
});

test("RETRIEVE accepts a keyed object answer (e.g. price range)", () => {
  const r = buildAgentResponse({ taskType: "RETRIEVE", state: "completed", answer: { min: 3.5, max: 99 } });
  assert.equal(r.status, "SUCCESS");
  assert.deepEqual(r.retrieved_data, { min: 3.5, max: 99 });
  assert.equal(buildAgentResponse({ taskType: "RETRIEVE", state: "completed", answer: {} }).status, "NOT_FOUND_ERROR");
});
