"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { capturePreferredObservation } = require("../main/harness/computer-use-observation");
const observation = { id: "obs", documentEpoch: 2 };
const options = { taskId: "task", imageInput: true };
const binding = { observationId: "obs", taskId: "task", documentEpoch: 2 };
const text = (sparse = false) => ({ binding, screenMap: { text: "button Apply", sparse, targets: [] } });
const image = () => ({ binding, attachment: { path: "/fake.png", async dispose() {} } });

test("rich DOM capture avoids images and leaves execution untouched", async () => {
  const capture = await capturePreferredObservation({ captureTextObservation: async () => text(), captureComputerUseObservation: async () => { throw new Error("unnecessary image"); } }, observation, options);
  assert.equal(capture.route, "text"); assert.equal(capture.visualCapture, null);
});
test("sparse DOM capture falls back to an image when supported", async () => {
  const capture = await capturePreferredObservation({ captureTextObservation: async () => text(true), captureComputerUseObservation: async () => image() }, observation, options);
  assert.equal(capture.route, "image"); assert.equal(capture.reason, "sparse_dom");
});
test("text-only models never receive screenshot attachments", async () => {
  const capture = await capturePreferredObservation({ captureTextObservation: async () => text(true), captureComputerUseObservation: async () => { throw new Error("image forbidden"); } }, observation, { ...options, imageInput: false });
  assert.equal(capture.route, "text");
});
test("definite DOM failure can request visual context but uncertain execution cannot", async () => {
  const browser = { captureTextObservation: async () => text(), captureComputerUseObservation: async () => image() };
  assert.equal((await capturePreferredObservation(browser, observation, { ...options, lastActionType: "click", lastActionStatus: "failed" })).reason, "dom_action_failed");
  assert.equal((await capturePreferredObservation(browser, observation, { ...options, lastActionType: "click", lastActionStatus: "uncertain" })).route, "text");
});
test("a stale image binding is rejected and its attachment cleaned up", async () => {
  let disposed = false;
  await assert.rejects(capturePreferredObservation({ captureComputerUseObservation: async () => ({ binding: { ...binding, documentEpoch: 1 }, attachment: { path: "/fake.png", async dispose() { disposed = true; } } }) }, observation, options), { code: "invalid_image_binding" });
  assert.equal(disposed, true);
});
test("a stale text binding cannot enter a text-only planner context", async () => {
  await assert.rejects(capturePreferredObservation({ captureTextObservation: async () => ({ ...text(), binding: { ...binding, taskId: "other-task" } }) }, observation, { ...options, imageInput: false }), { code: "invalid_text_binding" });
});
test("failure to capture any context fails rather than inventing an observation", async () => {
  await assert.rejects(capturePreferredObservation({}, observation, options), { code: "computer_use_unavailable" });
});
