// Contrast two Online-Mind2Web bench output directories on the tasks they share (no grading needed).
//   node integration/compare-runs.ts <dirA> <dirB>
// Pairs run.json by taskId and reports, per task and in total: verdict A -> B, planner calls, wall time, cost.
// A run that never finished a task is listed as "missing", not dropped. Tasks only count when both sides finished.
// Differences are only evidence for a change when the same task set is paired and the sample is large enough;
// the summary prints the paired count so a 3-task contrast is not read as a result.
const fs = require("node:fs");
const path = require("node:path");

type Run = { taskId: string; verdict: string; plannerCalls: number | null; wallMs: number | null; costUsd: number; model?: string };

function load(dir: string): Map<string, Run> {
  const out = new Map<string, Run>();
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, "run.json");
    if (!fs.existsSync(file)) continue;
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const costUsd = (r.usages ?? []).reduce((a: number, u: any) => a + (Number(u.costUsd) || 0), 0);
    out.set(String(r.taskId), { taskId: String(r.taskId), verdict: String(r.verdict), plannerCalls: r.plannerCalls ?? null, wallMs: r.wallMs ?? null, costUsd, model: r.model });
  }
  return out;
}

const median = (v: number[]) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "-");

function main() {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) { console.error("usage: node integration/compare-runs.ts <dirA> <dirB>"); process.exitCode = 2; return; }
  const a = load(dirA), b = load(dirB);
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  const paired: [Run, Run][] = [];
  const rows: string[] = [];
  for (const id of ids) {
    const ra = a.get(id), rb = b.get(id);
    if (!ra || !rb) { rows.push(`${id.slice(0, 8)}  ${ra?.verdict ?? "missing"} -> ${rb?.verdict ?? "missing"}`); continue; }
    paired.push([ra, rb]);
    const flip = ra.verdict === rb.verdict ? "same" : "FLIP";
    rows.push(`${id.slice(0, 8)}  ${ra.verdict} -> ${rb.verdict}  [${flip}]  calls ${ra.plannerCalls}->${rb.plannerCalls}  s ${fmt((ra.wallMs ?? NaN) / 1000, 0)}->${fmt((rb.wallMs ?? NaN) / 1000, 0)}  $ ${fmt(ra.costUsd, 2)}->${fmt(rb.costUsd, 2)}`);
  }
  const col = (pick: (r: Run) => number, side: 0 | 1) => median(paired.map((p) => pick(p[side])));
  const count = (side: 0 | 1, v: string) => paired.filter((p) => p[side].verdict === v).length;
  const verdicts = [...new Set(paired.flatMap((p) => [p[0].verdict, p[1].verdict]))].sort();
  console.log(rows.join("\n"));
  console.log(`\npaired tasks: ${paired.length} (A: ${a.size} runs, B: ${b.size} runs)  models: ${[...new Set([...a.values()].map((r) => r.model))].join(",")} vs ${[...new Set([...b.values()].map((r) => r.model))].join(",")}`);
  console.log(`verdict flips: ${paired.filter((p) => p[0].verdict !== p[1].verdict).length}`);
  for (const v of verdicts) console.log(`  ${v.padEnd(26)} A ${count(0, v)}  B ${count(1, v)}`);
  console.log(`median planner calls: A ${fmt(col((r) => r.plannerCalls ?? NaN, 0), 0)}  B ${fmt(col((r) => r.plannerCalls ?? NaN, 1), 0)}`);
  console.log(`median wall s:        A ${fmt(col((r) => (r.wallMs ?? NaN) / 1000, 0), 0)}  B ${fmt(col((r) => (r.wallMs ?? NaN) / 1000, 1), 0)}`);
  console.log(`median cost $:        A ${fmt(col((r) => r.costUsd, 0), 2)}  B ${fmt(col((r) => r.costUsd, 1), 2)}`);
  if (paired.length < 10) console.log("note: fewer than 10 paired tasks; treat differences as a direction, not a result");
}
main();
