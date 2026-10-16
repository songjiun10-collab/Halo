#!/usr/bin/env node
"use strict";
// Compare a HALO Online-Mind2Web run against Aside's published results.
// Usage: node tools/compare-aside-bench.js <halo-output-dir> <aside-results-dir> [grades.json]
// grades.json maps task_id -> "pass" | "fail" (HALO runs are ungraded: "finished" is not "pass").
// The denominator is every Aside task. A task HALO did not run, or that ended on a CAPTCHA, is not a pass.
const fs = require("node:fs");
const path = require("node:path");

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const sec = (ms) => (ms == null ? "n/a" : `${Math.round(ms / 1000)}s`);

function loadAside(dir) {
  const rows = [];
  for (const id of fs.readdirSync(dir)) {
    const r = readJson(path.join(dir, id, "result.json"));
    if (!r) continue;
    let solverCalls = 0;
    try { solverCalls = (fs.readFileSync(path.join(dir, id, "trajectory.txt"), "utf8").match(/captcha\.(click|drag|readText)/g) ?? []).length; } catch { /* no trajectory */ }
    rows.push({ id: r.task_id ?? id, pass: r.graderVerdict === "pass", impossible: r.outcome === "impossible", ms: r.durationMs, solverCalls });
  }
  return rows;
}

function loadHalo(dir) {
  const runs = new Map();
  for (const id of fs.readdirSync(dir)) {
    const run = readJson(path.join(dir, id, "run.json"));
    if (run) runs.set(run.taskId ?? id, run);
  }
  return runs;
}

function tokens(run) {
  let input = 0, output = 0;
  for (const u of run.usages ?? []) { input += Number(u.inputTokens ?? u.input_tokens ?? 0); output += Number(u.outputTokens ?? u.output_tokens ?? 0); }
  return { input, output };
}

function compare(aside, halo, grades) {
  const total = aside.length;
  const asidePass = aside.filter((r) => r.pass).length;
  const rows = aside.map((a) => {
    const run = halo.get(a.id);
    const verdict = run?.verdict ?? "not_run";
    return { a, run, verdict, pass: grades[a.id] === "pass" && verdict !== "blocked_by_captcha" };
  });
  const graded = Object.keys(grades).length > 0;
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const stopped = rows.filter((r) => r.verdict.startsWith("stopped")).length;
  const haloMs = rows.filter((r) => r.run).map((r) => r.run.wallMs);
  const asideMs = aside.map((r) => r.ms).filter((x) => Number.isFinite(x));
  const tok = rows.filter((r) => r.run).map((r) => tokens(r.run));
  const lines = [
    `# HALO vs Aside, Online-Mind2Web (denominator: ${total} Aside tasks)`,
    "",
    "| | Aside | HALO |", "|---|---|---|",
    `| Pass rate (all ${total}) | ${pct(asidePass, total)} (${asidePass}) | ${graded ? `${pct(rows.filter((r) => r.pass).length, total)} (${rows.filter((r) => r.pass).length})` : "ungraded"} |`,
    `| Blocked by CAPTCHA | n/a | ${count("blocked_by_captcha")} (counted as not passed) |`,
    `| Finished, not CAPTCHA-blocked | n/a | ${count("finished")} |`,
    `| Stopped (budget, need_user, ...) | n/a | ${stopped} |`,
    `| Runner errors / not run | n/a | ${count("runner_error")} / ${count("not_run")} |`,
    `| Wall time median / p90 | ${sec(q(asideMs, 0.5))} / ${sec(q(asideMs, 0.9))} | ${sec(q(haloMs, 0.5))} / ${sec(q(haloMs, 0.9))} |`,
    `| Tokens per task (median in/out) | not published | ${q(tok.map((t) => t.input), 0.5) ?? "n/a"} / ${q(tok.map((t) => t.output), 0.5) ?? "n/a"} |`,
    `| Tasks using Aside captcha tools | ${aside.filter((r) => r.solverCalls > 0).length} | HALO has no solver |`,
    "",
    graded ? "" : "HALO pass rate needs a grader: pass a grades.json (task_id -> \"pass\"|\"fail\"). \"Finished\" only means the agent stopped by itself.",
    "Aside's one \"impossible\" task is " + (aside.some((r) => r.impossible) ? "kept in the denominator" : "absent") + ".",
  ];
  return { text: lines.filter((l) => l !== undefined).join("\n"), total, asidePass, rows };
}

if (require.main === module) {
  const [haloDir, asideDir, gradesFile] = process.argv.slice(2);
  if (!haloDir || !asideDir) { process.stderr.write("usage: compare-aside-bench.js <halo-output-dir> <aside-results-dir> [grades.json]\n"); process.exit(2); }
  process.stdout.write(compare(loadAside(asideDir), loadHalo(haloDir), (gradesFile && readJson(gradesFile)) || {}).text + "\n");
}
module.exports = { compare, loadAside, loadHalo, tokens, q };
