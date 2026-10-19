"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectTasks, alternateRoute, MAX_REROUTES, plannerWorker, classify, resolveProfile, hedgedAnswer, siteKey } = require("../integration/online-mind2web-bench.ts");

const row = (i, over = {}) => ({ task_id: `t${i}`, confirmed_task: "Find a thing", website: "https://example.test/", reference_length: 5, level: "easy", ...over });

test("bench takes every dataset task, honours a limit, and rejects non-https or credentialed start URLs", () => {
  const rows = [row(1), row(2), row(3)];
  assert.equal(selectTasks(rows).length, 3);
  assert.equal(selectTasks(rows, 2).length, 2);
  assert.throws(() => selectTasks([]), /task_binding/);
  assert.throws(() => selectTasks([row(1, { website: "file:///etc/passwd" })]), /task_binding/);
  assert.throws(() => selectTasks([row(1, { website: "https://u:p@example.test/" })]), /task_binding/);
  assert.throws(() => selectTasks([row(1, { reference_length: "5" })]), /task_binding/);
});

test("Claude model ids use the Claude planner worker, everything else the Codex one", () => {
  assert.match(plannerWorker("claude-haiku-5-5").file, /claude-code-worker\.js$/);
  assert.deepEqual(plannerWorker("claude-haiku-5-5").args, ["--model", "claude-haiku-5-5"]);
  assert.match(plannerWorker("gpt-5.5").file, /codex-planner-worker\.js$/);
});

test("a task that ends on a CAPTCHA page is labelled blocked_by_captcha, not failed or solved", () => {
  assert.equal(classify({ state: "paused", pauseReason: "need_user" }, "https://www.google.com/recaptcha/api2/anchor", "", null), "blocked_by_captcha");
  assert.equal(classify({ state: "paused", pauseReason: "need_user" }, "https://shop.example/", "Are you a robot?", null), "blocked_by_captcha");
  assert.equal(classify({ state: "completed" }, "https://shop.example/cart", "Cart", null), "finished");
  assert.equal(classify({ state: "completed" }, "https://a.test/", "A", null, false, false, true), "unverified_finish");
  const nu = { state: "paused", pauseReason: "need_user" };
  assert.equal(classify(nu, "https://a.test/", "A", null, true), "answered");
  assert.equal(classify(nu, "https://a.test/", "A", null, true, false, true), "unverified_report");
  assert.equal(classify(nu, "https://a.test/", "A", null, true, true, true), "blocked_report");
  assert.equal(classify({ state: "awaiting_verification" }, "https://a.test/", "A", null), "unconfirmed_finish");
  assert.equal(classify({ state: "awaiting_verification" }, "https://a.test/", "A", null, false, false, true), "unverified_finish");
  assert.equal(classify({ state: "paused", pauseReason: "budget" }, "https://shop.example/", "Shop", null), "stopped:budget");
  assert.equal(classify(null, "", "", "bench_error"), "runner_error");
});

test("safety stays on unless HALO_BENCH_OPEN_UNSAFE=1 is set exactly", () => {
  for (const env of [{}, { HALO_BENCH_OPEN_UNSAFE: "0" }, { HALO_BENCH_OPEN_UNSAFE: "true" }]) {
    const p = resolveProfile(env);
    assert.equal(p.safetyDisabled, false);
    assert.equal(p.permissionMode, "browse");
    assert.equal(p.approve({ action: "click" }).decision, "review");
    assert.equal(p.approve({ action: "navigate" }).decision, "allow");
  }
  const open = resolveProfile({ HALO_BENCH_OPEN_UNSAFE: "1" });
  assert.equal(open.safetyDisabled, true);
  assert.equal(open.permissionMode, "full");
});

test("captcha pages are rerouted to the site root, then a search, then left alone (bounded, no solving)", () => {
  const task = row(1, { website: "https://shop.example/a/b?x=1", confirmed_task: "Find red shoes" });
  assert.equal(alternateRoute(task, 0), "https://shop.example/");
  assert.match(alternateRoute(task, 1), /^https:\/\/search\.brave\.com\/search\?q=site%3Ashop\.example%20Find%20red%20shoes$/);
  assert.match(alternateRoute(task, 2), /^https:\/\/html\.duckduckgo\.com\/html\/\?q=site%3Ashop\.example/);
  assert.match(alternateRoute(task, 3), /^https:\/\/www\.startpage\.com\//);
  assert.match(alternateRoute(task, 4), /^https:\/\/www\.mojeek\.com\//);
  assert.equal(alternateRoute(task, 5), null);
  assert.equal(MAX_REROUTES, 5);
});

test("plannerWorker sends vendor/model ids to the NVIDIA worker", () => {
  const w = plannerWorker("deepseek-ai/deepseek-v4.1-flash");
  assert.ok(w.file.endsWith("nvidia-planner-worker.js"));
  assert.deepEqual(w.args, ["--model", "deepseek-ai/deepseek-v4.1-flash"]);
  assert.ok(plannerWorker("claude-haiku-5-5").file.endsWith("claude-code-worker.js"));
});

test("plannerWorker sends oc: ids to the OpenCode worker", () => {
  const w = plannerWorker("oc:nvidia/deepseek-ai/deepseek-v4.1-flash");
  assert.ok(w.file.endsWith("opencode-planner-worker.js"));
  assert.deepEqual(w.args, ["--model", "nvidia/deepseek-ai/deepseek-v4.1-flash"]);
});

test("an answer that admits it is incomplete or asks the user to choose is hedged_answer, not answered", () => {
  const nu = { state: "paused", pauseReason: "need_user" };
  assert.equal(hedgedAnswer("증상은 아직 확인하지 못했습니다."), true);
  assert.equal(hedgedAnswer("어떤 기준으로 할지 정해 주시겠어요?"), true);
  assert.equal(hedgedAnswer("Let me know which review you prefer, or which would you prefer?"), true);
  assert.equal(hedgedAnswer("참고: 실제 결제 단계까지는 확인하지 않았습니다."), false, "a caveat on a finished answer is not a refusal");
  assert.equal(hedgedAnswer("Standard 플랜은 월 $100입니다. 출처: https://example.test/pricing"), false);
  assert.equal(classify(nu, "https://a.test/", "A", null, true, false, false, true), "hedged_answer");
  assert.equal(classify(nu, "https://a.test/", "A", null, true, false, false, false), "answered");
  assert.equal(classify(nu, "https://a.test/", "A", null, true, false, true, true), "unverified_report", "unverified still wins");
});

test("a task whose own site only ever refused is blocked_by_site, a failure in its own column; captcha still wins", () => {
  const nu = { state: "paused", pauseReason: "need_user" };
  assert.equal(siteKey("https://new.mta.info/x"), "mta.info");
  assert.equal(siteKey("www.mta.info"), "mta.info");
  assert.equal(classify(nu, "https://en.wikipedia.org/wiki/X", "X", null, true, false, true, false, true), "blocked_by_site");
  assert.equal(classify(nu, "https://a.test/", "A", null, true, false, true, false, false), "unverified_report", "site loaded at least once");
  assert.equal(classify({ state: "completed" }, "https://a.test/", "A", null, false, false, false, false, true), "finished", "a verified completion is not a block");
  assert.equal(classify(nu, "https://shop.example/", "Are you a robot?", null, false, false, false, false, true), "blocked_by_captcha");
});
