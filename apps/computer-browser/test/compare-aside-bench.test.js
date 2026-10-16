"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, q } = require("../../../tools/compare-aside-bench");

const aside = [1, 2, 3, 4].map((i) => ({ id: `t${i}`, pass: i !== 4, impossible: false, ms: i * 1000, solverCalls: i === 2 ? 3 : 0 }));
const run = (taskId, verdict, wallMs = 5000) => [taskId, { taskId, verdict, wallMs, usages: [{ inputTokens: 100, outputTokens: 10 }] }];

test("denominator is every Aside task; CAPTCHA-blocked and unrun tasks never count as passes", () => {
  const halo = new Map([run("t1", "finished"), run("t2", "blocked_by_captcha")]);
  const out = compare(aside, halo, { t1: "pass", t2: "pass" });
  assert.equal(out.total, 4);
  assert.equal(out.rows.filter((r) => r.pass).length, 1);
  assert.match(out.text, /25\.0% \(1\)/);
  assert.match(out.text, /Blocked by CAPTCHA \| n\/a \| 1/);
  assert.match(out.text, /not_run|0 \/ 2/);
});

test("without grades HALO is reported as ungraded, never as a pass rate", () => {
  const out = compare(aside, new Map([run("t1", "finished")]), {});
  assert.match(out.text, /ungraded/);
  assert.equal(q([3, 1, 2], 0.5), 2);
});
