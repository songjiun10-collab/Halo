"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { gradeOne, parseVerdict, JUDGE } = require("../../../tools/grade-bench");

const result = { task: "Find jobs", agent_final_answer: "Found 13 jobs", action_history: ["a", "b"] };
const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test("default judge is DeepSeek V4.1 Flash", () => assert.equal(JUDGE, "deepseek-ai/deepseek-v4.1-flash"));

test("CAPTCHA-blocked and answerless runs fail without calling the judge", async () => {
  const boom = async () => { throw new Error("must not call"); };
  assert.equal((await gradeOne({ verdict: "blocked_by_captcha" }, result, { fetchFn: boom })).verdict, "fail");
  assert.equal((await gradeOne({ verdict: "finished" }, { ...result, agent_final_answer: "" }, { fetchFn: boom })).verdict, "fail");
});

test("judge replies parse; garbage and HTTP errors never become a pass", async () => {
  assert.equal((await gradeOne({ verdict: "finished", finalUrl: "u" }, result, { fetchFn: reply('ok {"verdict":"pass","reason":"x"}') })).verdict, "pass");
  assert.equal((await gradeOne({ verdict: "finished", finalUrl: "u" }, result, { fetchFn: reply("maybe") })).verdict, "fail");
  await assert.rejects(gradeOne({ verdict: "finished", finalUrl: "u" }, result, { fetchFn: async () => ({ ok: false, status: 429 }) }), /judge_http_429/);
  assert.equal(parseVerdict('{"verdict":"yes"}'), null);
});
