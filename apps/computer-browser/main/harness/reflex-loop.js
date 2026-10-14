"use strict";

// The host-side reflex loop behind the play_loop action. A planner call takes seconds, far too slow for a
// game that wants a key within tens of milliseconds, so the planner states a small rule once (which screen
// point means "press this key") and this loop applies it many times a second until a time limit, a press cap
// or the stop button ends it. `sample()` answers, per lane, whether the trigger is on screen right now.

const DEFAULT_INTERVAL_MS = 8;
const DEFAULT_COOLDOWN_MS = 100;
const DEFAULT_MAX_PRESSES = 2000;

async function runReflexLoop({
  lanes, seconds, sample, press,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal, intervalMs = DEFAULT_INTERVAL_MS, cooldownMs = DEFAULT_COOLDOWN_MS, maxPresses = DEFAULT_MAX_PRESSES,
}) {
  const startedAt = now();
  const limit = seconds * 1000;
  const presses = lanes.map(() => 0);
  const lastPressAt = lanes.map(() => -Infinity);
  let total = 0;
  let frames = 0;
  const finish = (stopped) => ({ stopped, presses, total, frames, elapsedMs: now() - startedAt });

  for (;;) {
    if (signal?.aborted) return finish("aborted");
    const passStart = now();
    if (passStart - startedAt >= limit) return finish("time");

    let hits;
    try { hits = await sample(); } catch { return finish("sampler_failed"); }
    if (!Array.isArray(hits) || hits.length !== lanes.length) return finish("sampler_failed");
    frames += 1;

    for (let i = 0; i < lanes.length; i += 1) {
      if (!hits[i]) continue;
      const at = now();
      // A note stays on the line for several passes; one press per note.
      if (at - lastPressAt[i] < cooldownMs) continue;
      if (total >= maxPresses) return finish("max_presses");
      lastPressAt[i] = at;
      try { await press(lanes[i].key); } catch { return finish("press_failed"); }
      presses[i] += 1;
      total += 1;
    }
    if (total >= maxPresses) return finish("max_presses");

    // Pace to the interval, but never sleep after a pass that was already slower than it.
    const spent = now() - passStart;
    if (spent < intervalMs) await sleep(intervalMs - spent);
  }
}

module.exports = { runReflexLoop, DEFAULT_INTERVAL_MS, DEFAULT_COOLDOWN_MS, DEFAULT_MAX_PRESSES };
