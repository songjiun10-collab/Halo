"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsHumanInput } = require("../tools/bench-runner");

test("only a secret or personal-details pause counts as waiting for the person", () => {
  const paused = (needUserReason, pauseReason = "need_user") => ({ state: "paused", pauseReason, needUserReason });
  assert.equal(needsHumanInput(paused("[비밀 정보] 카드번호는 직접 입력해 주세요.")), true);
  assert.equal(needsHumanInput(paused("[개인 식별 정보] 전화번호를 입력하려고 합니다.")), true);
  assert.equal(needsHumanInput(paused("which size?")), false, "an ordinary question is a task result, not an assist");
  assert.equal(needsHumanInput(paused("[비밀 정보] x", "captcha")), false);
  assert.equal(needsHumanInput({ state: "running" }), false);
  assert.equal(needsHumanInput(null), false);
});

const { runTask, ASSIST_LIMIT } = require("../tools/bench-runner");

function fakeClient({ detail, resume }) {
  const calls = { resume: 0, stop: 0 };
  return {
    calls,
    createTask: async () => ({ taskId: "t1", snapshot: {} }),
    getTaskDetail: async () => ({ snapshot: detail(calls) }),
    resumeSavedTask: async () => { calls.resume += 1; return resume(calls); },
    stopTask: async () => { calls.stop += 1; },
  };
}
const NEED = { state: "paused", pauseReason: "need_user", needUserReason: "[비밀 정보] 카드번호는 직접 입력해 주세요." };
const quiet = { sleep: async () => {}, log: () => {} };

test("a person is asked at most ASSIST_LIMIT times per task, and a failing resume is reported and counted", async () => {
  const logs = [];
  let asked = 0;
  const client = fakeClient({ detail: () => NEED, resume: () => { throw Object.assign(new Error("boom"), { code: "resume_failed" }); } });
  const row = await runTask(client, { task_id: "abcdefgh-1", level: "hard" }, 60_000, true, { ...quiet, ask: async () => { asked += 1; }, log: (m) => logs.push(m) });
  assert.equal(ASSIST_LIMIT, 5);
  assert.equal(asked, ASSIST_LIMIT, "the person is asked five times and then the loop ends");
  assert.equal(row.assists, ASSIST_LIMIT);
  assert.equal(row.state, "paused");
  assert.equal(row.pauseReason, "need_user");
  assert.equal(client.calls.stop, 1, "the capped task is ended so it does not hold the queue slot");
  assert.equal(logs.length, ASSIST_LIMIT);
  assert.match(logs[0], /resume_failed/, "the error code is shown, not swallowed");
});

test("one successful assist lets the task finish; human wait time stays out of the duration", async () => {
  let asked = 0;
  const client = fakeClient({ detail: (calls) => (calls.resume === 0 ? NEED : { state: "completed", pauseReason: null }), resume: () => ({}) });
  const row = await runTask(client, { task_id: "abcdefgh-2", level: "easy" }, 60_000, true, { ...quiet, ask: async () => { asked += 1; await new Promise((r) => setTimeout(r, 30)); } });
  assert.equal(row.state, "completed");
  assert.equal(row.assists, 1);
  assert.ok(row.humanWaitMs >= 25, "the wait is recorded");
  assert.ok(row.durationMs < row.humanWaitMs + 1000 && row.durationMs >= 0);
  assert.equal(asked, 1);
});

test("without --assist a secret-input pause is simply the result", async () => {
  const client = fakeClient({ detail: () => NEED, resume: () => assert.fail("must not resume") });
  const row = await runTask(client, { task_id: "abcdefgh-3", level: "hard" }, 60_000, false, { ...quiet, ask: async () => assert.fail("must not ask") });
  assert.equal(row.pauseReason, "need_user");
  assert.equal("assists" in row, false);
});
