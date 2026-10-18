"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectTasks, alternateRoute, MAX_REROUTES, plannerWorker, classify, resolveProfile } = require("../integration/online-mind2web-bench.ts");

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
