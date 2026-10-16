#!/usr/bin/env node
"use strict";
// Grade a HALO Online-Mind2Web run with an LLM judge (default: DeepSeek V4.1 Flash on NVIDIA NIM).
// Usage: NVIDIA_API_KEY=... node tools/grade-bench.js <halo-output-dir> [grades.json]
// Text only: the judge sees the task, the agent's final answer, the final URL and the action history,
// not screenshots. Aside graded with a different model, so a score from this judge is not directly
// comparable to Aside's 99%; say which judge produced a number whenever you quote it.
const fs = require("node:fs");
const path = require("node:path");

const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const JUDGE = process.env.HALO_BENCH_JUDGE || "deepseek-ai/deepseek-v4.1-flash";

function judgePrompt(run, result) {
  return [
    "You are a strict grader for a web-agent benchmark. Decide whether the agent completed the TASK.",
    "Pass only if the final answer or the final page state shows the task was done, with specifics that match the task. Refusals, guesses, partial results and unverifiable claims fail.",
    'Reply with JSON only: {"verdict":"pass"|"fail","reason":"one sentence"}.',
    `TASK: ${result.task}`,
    `FINAL URL: ${run.finalUrl}`,
    `AGENT FINAL ANSWER: ${String(result.agent_final_answer).slice(0, 3000)}`,
    `ACTIONS (${(result.action_history ?? []).length}): ${(result.action_history ?? []).slice(-25).join(" | ").slice(0, 3000)}`,
  ].join("\n");
}

function parseVerdict(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ""));
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v.verdict === "pass" || v.verdict === "fail" ? v : null; } catch { return null; }
}

async function gradeOne(run, result, { apiKey, fetchFn = globalThis.fetch, model = JUDGE } = {}) {
  // A CAPTCHA-blocked or unfinished run is a fail without asking a model.
  if (run.verdict === "blocked_by_captcha") return { verdict: "fail", reason: "blocked_by_captcha" };
  if (!result?.agent_final_answer) return { verdict: "fail", reason: `no final answer (${run.verdict})` };
  const res = await fetchFn(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 400, messages: [{ role: "user", content: judgePrompt(run, result) }] }) });
  if (!res.ok) throw new Error(`judge_http_${res.status}`);
  const parsed = parseVerdict((await res.json()).choices?.[0]?.message?.content);
  return parsed ?? { verdict: "fail", reason: "unparseable judge reply (counted as fail)" };
}

async function main() {
  const [dir, out = path.join(process.argv[2] ?? ".", "grades.json")] = process.argv.slice(2);
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!dir || !apiKey) { process.stderr.write("usage: NVIDIA_API_KEY=... grade-bench.js <halo-output-dir> [grades.json]\n"); process.exit(2); }
  const grades = {}, detail = {};
  for (const id of fs.readdirSync(dir)) {
    let run, result;
    try { run = JSON.parse(fs.readFileSync(path.join(dir, id, "run.json"), "utf8")); result = JSON.parse(fs.readFileSync(path.join(dir, id, "result.json"), "utf8")); } catch { continue; }
    try { const g = await gradeOne(run, result, { apiKey }); grades[run.taskId ?? id] = g.verdict; detail[run.taskId ?? id] = g.reason; }
    catch (error) { process.stderr.write(`${id}: ${error.message}\n`); }
  }
  fs.writeFileSync(out, JSON.stringify(grades, null, 2));
  fs.writeFileSync(out.replace(/\.json$/, "") + ".reasons.json", JSON.stringify({ judge: JUDGE, text_only: true, reasons: detail }, null, 2));
  process.stdout.write(`graded ${Object.keys(grades).length} with ${JUDGE} (text only) -> ${out}\n`);
}

if (require.main === module) main();
module.exports = { gradeOne, parseVerdict, judgePrompt, JUDGE };
