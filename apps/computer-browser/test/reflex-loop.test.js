"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runReflexLoop } = require("../main/harness/reflex-loop");

// A fake clock: sleeping moves time, so the loop runs in microseconds of real time.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}
const lanes = [{ key: "d" }, { key: "f" }, { key: "j" }];

test("a lane is pressed once per note: while the note stays on the line it is not pressed again", async () => {
  const c = clock();
  const pressed = [];
  // Lane 0 shows a note from t=100 to t=160 (it lingers on the line), then another from t=500 to t=520.
  const sample = async () => [(c.now() >= 100 && c.now() < 160) || (c.now() >= 500 && c.now() < 520), false, false];
  const result = await runReflexLoop({ lanes, seconds: 1, sample, press: async (key) => { pressed.push([key, c.now()]); }, ...c, intervalMs: 8, cooldownMs: 100 });
  assert.deepEqual(pressed.map(([key]) => key), ["d", "d"]);
  assert.ok(pressed[0][1] >= 100 && pressed[0][1] < 120, `pressed right when the note arrived: ${pressed[0][1]}`);
  assert.deepEqual(result.presses, [2, 0, 0]);
  assert.equal(result.stopped, "time");
});

test("lanes are independent, and two notes at once are both pressed in the same pass", async () => {
  const c = clock();
  const pressed = [];
  const sample = async () => [c.now() >= 50 && c.now() < 60, c.now() >= 50 && c.now() < 60, false];
  await runReflexLoop({ lanes, seconds: 0.3, sample, press: async (key) => { pressed.push(key); }, ...c });
  assert.deepEqual(pressed.sort(), ["d", "f"]);
});

test("it stops at the time limit and never runs past it", async () => {
  const c = clock();
  const result = await runReflexLoop({ lanes, seconds: 2, sample: async () => [false, false, false], press: async () => {}, ...c, intervalMs: 10 });
  assert.equal(result.stopped, "time");
  assert.ok(result.elapsedMs >= 2000 && result.elapsedMs < 2100, `${result.elapsedMs}`);
});

test("the press cap ends a runaway loop", async () => {
  const c = clock();
  const result = await runReflexLoop({ lanes, seconds: 60, sample: async () => [true, true, true], press: async () => {}, ...c, intervalMs: 8, cooldownMs: 10, maxPresses: 25 });
  assert.equal(result.stopped, "max_presses");
  assert.equal(result.total, 25);
});

test("the stop button wins: an aborted signal ends the loop within one pass", async () => {
  const c = clock();
  const controller = new AbortController();
  let passes = 0;
  const sample = async () => { passes += 1; if (passes === 5) controller.abort(); return [false, false, false]; };
  const result = await runReflexLoop({ lanes, seconds: 60, sample, press: async () => {}, ...c, signal: controller.signal });
  assert.equal(result.stopped, "aborted");
  assert.ok(passes <= 6);
});

test("an unreadable screen or a failing key press ends the loop with a reason instead of throwing", async () => {
  const c = clock();
  const unreadable = await runReflexLoop({ lanes, seconds: 5, sample: async () => { throw new Error("tainted canvas"); }, press: async () => {}, ...c });
  assert.equal(unreadable.stopped, "sampler_failed");
  const noKeys = await runReflexLoop({ lanes, seconds: 5, sample: async () => [true, false, false], press: async () => { throw new Error("page gone"); }, ...c });
  assert.equal(noKeys.stopped, "press_failed");
  const wrongShape = await runReflexLoop({ lanes, seconds: 5, sample: async () => [true], press: async () => {}, ...c });
  assert.equal(wrongShape.stopped, "sampler_failed", "a sample that does not match the lanes is a failure, not a guess");
});

test("a slow sampler is not made worse: the loop does not sleep when a pass already took longer than the interval", async () => {
  const c = clock();
  let passes = 0;
  const sample = async () => { passes += 1; c.advance(50); return [false, false, false]; };
  const result = await runReflexLoop({ lanes, seconds: 1, sample, press: async () => {}, now: c.now, sleep: async (ms) => { c.advance(ms); }, intervalMs: 8 });
  assert.ok(passes >= 19 && passes <= 21, `${passes} passes in a second at 50 ms each`);
  assert.equal(result.stopped, "time");
});
