"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  createScreenshotAttachment,
  validateCoordinateAction,
  validateScreenshotAttachment,
} = require("../main/harness/computer-use-contract");

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVATION_ID = "33333333-3333-4333-8333-333333333333";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const observation = {
  id: OBSERVATION_ID,
  documentEpoch: 7,
  url: "https://example.test/work?tab=1",
  title: "Fixture",
  text: "untrusted page text",
  elements: [],
  at: 1234,
};

test("screenshot attachment binds PNG digest and capture metadata to one observation and removes its private file idempotently", async () => {
  const result = await createScreenshotAttachment({
    png: PNG,
    taskId: TASK_ID,
    agentId: AGENT_ID,
    observation,
    viewport: { width: 1440, height: 900 },
    capturedAt: 5678,
  });

  assert.deepEqual(Object.keys(result), ["binding", "attachment"]);
  assert.deepEqual(Object.keys(result.binding), ["observationId", "taskId", "agentId", "documentEpoch", "origin", "capturedAt", "viewport", "digest"]);
  assert.deepEqual(result.binding, {
    observationId: OBSERVATION_ID,
    taskId: TASK_ID,
    agentId: AGENT_ID,
    documentEpoch: 7,
    origin: "https://example.test",
    capturedAt: 5678,
    viewport: { width: 1440, height: 900 },
    digest: "0f6c3a09018d44c79811cb205e1e03f0f214fdd8728f82e6e92aaaf95da5ee49",
  });
  assert.equal(result.attachment.path.endsWith(".png"), true);
  assert.deepEqual(await fsp.readFile(result.attachment.path), PNG);
  const directoryStat = await fsp.stat(path.dirname(result.attachment.path));
  const fileStat = await fsp.stat(result.attachment.path);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
  await result.attachment.dispose();
  await result.attachment.dispose();
  assert.equal(fs.existsSync(path.dirname(result.attachment.path)), false);
});

test("screenshot attachment rejects non-HTTP origins, invalid viewport, and empty image bytes", async () => {
  const base = {
    png: PNG,
    taskId: TASK_ID,
    agentId: null,
    observation,
    viewport: { width: 1440, height: 900 },
    capturedAt: 1,
  };
  await assert.rejects(createScreenshotAttachment({ ...base, observation: { ...observation, url: "file:///tmp/page.html" } }), { code: "invalid_visual_observation" });
  await assert.rejects(createScreenshotAttachment({ ...base, viewport: { width: 0, height: 900 } }), { code: "invalid_visual_observation" });
  await assert.rejects(createScreenshotAttachment({ ...base, png: Buffer.alloc(0) }), { code: "invalid_visual_observation" });
});

test("coordinate action contract accepts bounded normalized actions with exact fields only", () => {
  assert.deepEqual(validateCoordinateAction({ type: "click_at", observationId: OBSERVATION_ID, x: 0, y: 0.999 }), {
    type: "click_at", observationId: OBSERVATION_ID, x: 0, y: 0.999,
  });
  assert.deepEqual(validateCoordinateAction({ type: "type_at", observationId: OBSERVATION_ID, x: 0.5, y: 0.25, text: "검색어" }), {
    type: "type_at", observationId: OBSERVATION_ID, x: 0.5, y: 0.25, text: "검색어",
  });
  for (const invalid of [
    { type: "click_at", observationId: OBSERVATION_ID, x: -0.01, y: 0.5 },
    { type: "click_at", observationId: OBSERVATION_ID, x: 1, y: 0.5 },
    { type: "click_at", observationId: OBSERVATION_ID, x: NaN, y: 0.5 },
    { type: "click_at", observationId: OBSERVATION_ID, x: 0.5, y: Infinity },
    { type: "click_at", observationId: OBSERVATION_ID, x: 0.5, y: 0.5, url: "https://attacker.test" },
    { type: "type_at", observationId: OBSERVATION_ID, x: 0.5, y: 0.5, text: "x".repeat(4097) },
    { type: "type_at", observationId: OBSERVATION_ID, x: 0.5, y: 0.5, text: "ok", key: "Enter" },
  ]) assert.throws(() => validateCoordinateAction(invalid), { code: "invalid_coordinate_action" });
});

test("planner attachment validation accepts only private regular HALO PNGs and rejects symlink paths", async () => {
  const result = await createScreenshotAttachment({ png: PNG, taskId: TASK_ID, agentId: AGENT_ID, observation, viewport: { width: 1440, height: 900 }, capturedAt: 1 });
  assert.deepEqual(await validateScreenshotAttachment({ kind: "image", id: result.attachment.id, path: result.attachment.path }), {
    kind: "image", id: result.attachment.id, path: result.attachment.path, digest: result.binding.digest,
  });
  await assert.rejects(validateScreenshotAttachment({ kind: "image", id: result.attachment.id, path: "/tmp/other.png" }), { code: "invalid_attachment" });
  await assert.rejects(validateScreenshotAttachment({ kind: "image", id: result.attachment.id, path: result.attachment.path, url: "https://evil.test" }), { code: "invalid_attachment" });
  await result.attachment.dispose();
  await assert.rejects(validateScreenshotAttachment({ kind: "image", id: result.attachment.id, path: result.attachment.path }), { code: "invalid_attachment" });
});
