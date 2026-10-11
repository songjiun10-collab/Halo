# Same-site navigation pacing jitter

## Scope

The politeness gap between page loads on one site (task-controller.js
`SAME_SITE_NAV_INTERVAL_MS`, consumed by `_paceNavigation`) was a perfectly
uniform 1500ms. A uniform gap is itself a robot signature: bot detection
accumulates request-cadence statistics across a session, so an exactly even
interval is one of the cheapest signals to read.

- The effective interval is now `navIntervalMs + jitter`, uniform in
  `[floor, floor + NAV_JITTER_MAX_MS]` (default 1000ms).
- Jitter is drawn **fresh for each navigation**, before the pacing loop.
  Drawing once per origin would keep the within-origin cadence uniform —
  which is the signature that matters — and drawing inside the loop would
  move the deadline every 250ms slice.
- The floor is never shortened. Jitter is upward-only, and the drawn value is
  clamped at 0 so even a misbehaving injected source cannot produce a
  negative interval.
- New constructor options `navJitterMaxMs` (clamped to >= 0; non-finite or
  negative turns jitter off) and `navJitter` (injectable
  `(maxMs) => number` source; default `crypto.randomInt`). Same pattern as
  `navIntervalMs`: a constructor option with a frozen default, not
  settings-wired.

This is a politeness improvement, not evasion. It reduces accidental
uniform-cadence signatures; it does not make the agent undetectable, does not
touch the CAPTCHA policy (a concurrent session tightened that to an immediate
pause — challenge clicks stay with the person), and does not change approval
or retry behavior.

## Red/green evidence

`test/task-controller-pacing.test.js` pins the jitter source, so the tests are
deterministic; event-loop slop only ever lengthens a gap.

| Test | Before | After |
| --- | --- | --- |
| Injected jitter applied on top of the floor (2 same-site loads, floor 50ms, pinned jitter 500ms) | **fail** — gap 56ms, jitter never applied | pass — gap includes the 500ms |
| Jitter drawn fresh per navigation, not fixed per origin (4 loads, pinned queue `[0,400,0,400,0]`) | **fail** — gaps `[52,52,51]`, spread 1ms | pass — spread > 200ms |
| Floor never shortened, with default randomness and with `navJitterMaxMs: -5` | pass (guard) | pass |
| `navIntervalMs 0` disables pacing entirely, jitter or not | pass (guard) | pass |

The `before` gaps of `[52,52,51]` are exactly the uniform-cadence signature
this change removes. The existing floor test
(`task-controller-recovery.test.js`, "page loads on the same site are spaced
by the navigation interval") now pins `navJitter: () => 0` so it tests the
floor exactly and stays fast; jitter-on-top is covered by the new file.

Focused runs: **21 pass, 0 fail** (new pacing file plus
task-controller-recovery.test.js), and **124 pass, 0 fail** across
task-controller.test.js and task-controller-interactions.test.js.

## Cost

Jitter uniform in `[0, 1000]` averages +500ms per same-site navigation
(`navigate`/`follow_link` only; clicks, scrolls and typing are not paced).
Over a ~30s task with a few same-site loads this is a small fraction of wall
time; it is not free, and it is the deliberate price of not reading as an
exactly even cadence.

## Limits and verification status

- The default jitter distribution (uniform over `[floor, floor + 1000]`) is a
  property of `crypto.randomInt`, verifiable by sampling; no wall-clock
  benchmark was run, so no latency claim is made beyond the cost above.
- This change does not measure, claim or imply a bot-detection success rate.
  Whether uniform cadence was the cause of the pilot's Cloudflare/MTA blocks
  was never established and remains unknown.
- Repo-wide checks were re-run once the concurrent patch wave settled:
  `npm run typecheck` and `npm run check:runtime` both exit 0, and the focused
  controller run is **124 pass, 0 fail**. The earlier failures (a TS2345 in
  the other session's in-flight `cdp-web-contents.ts`, a RUNTIME_CHANGED
  fingerprint mismatch from sources changing mid-check) were entirely from
  that concurrent editing and are gone.
- Full repository suite was not run; full-suite green beyond the focused
  controller files is not claimed.
- No commit or push performed. Concurrent sessions' unrelated changes are
  preserved.
