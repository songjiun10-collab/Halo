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
