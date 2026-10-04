# Harness real-agent usability: findings from a goal-style run with a real model

**Trigger:** every earlier benchmark used a scripted planner. To see what happens with a real model, `integration/llm-goal-run.js` hands the local `claude` CLI (through the existing `claude-code-worker` provider) one natural-language goal ("find the page containing TARGET-FOUND, start at <url>; some sections are dead ends") and lets it drive the harness on a real Electron `BrowserAdapter`. Local synthetic site (13 pages), immediate programmatic approval, no real site or credentials. Data flow: each planner call sends the goal, journal events and the current observation to the Anthropic API via the local login (see `providers/README.ko.md`).

## Three real defects the first runs exposed (all fixed)

1. **The profile's batch cap never reached the model.** The bridge prompt hardcoded "propose 1-3 browser actions", so a `short` task's cap of 8 was invisible to a real planner. `TaskController` now puts `maxActionsPerProposal` in `context.progress`; the prompt uses it only when it equals a reviewed bound (3 or 8), else stays 3 (a number arriving inside the context packet is not trusted).
2. **A stray field caused a 2-minute stall.** The model sent `kind: "actions"` together with `reason`; the strict validator rejected it, the worker (by design, no error frame in the JSONL protocol) left the request unanswered, and the 120 s planner timeout paused the task with `planner_error`. The prompt now states the exact field set per `kind`. The stall-on-rejected-proposal design itself is unchanged and still a candidate for a follow-up (an explicit error frame).
3. **No memory of where the agent had been.** At a dead end the model looped on `observe`/`scroll` for 4 minutes (43 planner calls, 3 pages visited, target never found), because the context held only the current page and journal ids: it could not know it came from a parent page or that sibling links remained. The host now records visited pages and links seen but not yet visited (`context.navigationHistory`, labeled `untrusted_page_derived`, bounded to 32 + 32 entries of ≤512 / ≤80 chars, deduplicated, http(s) only) and the prompt tells the model to backtrack with `navigate` to a frontier href, depth-first. In-memory only: a restarted controller rebuilds it from fresh observations.

## Result after the fixes

4 runs (order middle, short, short, middle), all found the target:

| profile | time to target | planner calls | actions | mean actions / proposal | median planner call |
|---|---:|---:|---:|---:|---:|
| middle | 45.4 s | 11 | 11 | 1.00 | 3.7 s |
| short | 48.8 s | 11 | 11 | 1.00 | 4.5 s |
| short | 45.8 s | 11 | 13 | 1.18 | 4.5 s |
| middle | 44.4 s | 11 | 14 | 1.27 | 4.0 s |

(Before fix 3: not found in 4 minutes. First fixed run, short: found in 42.8 s, 11 calls.)

What this says, without overreach:
- **With a real model the profile made no measurable difference on this task.** The model almost never batched (mean 1.0-1.3 actions per proposal), so `short`'s wider cap went unused; exploration steps are sequential by nature. The batching gains measured earlier came from scripted planners that batch scrolls. Whether a real model batches more on read-heavy tasks was not tested.
- **Planner latency is the cost.** 11 calls × ~4 s ≈ the whole ~45 s. The harness's own overhead measured earlier (about 7-8 ms per page) is negligible next to it, so on real runs the lever that matters is the number of planner round-trips, not harness speed.
- 4 runs, 1 site, 1 goal: an existence check, not a statistical comparison.

## Planner effort vs. latency (2026-09-30, real model, `short`)

Same site, goal and build; only `HALO_LLM_EFFORT` differs (`llm-goal-run.js`, 3 runs each, all found the target, 100% of runs):

| effort | time to target | planner calls | seconds / call |
|---|---|---|---|
| medium (default) | 62.1 s / 61.2 s / 51.4 s | 13 / 11 / 11 | 4.78 / 5.56 / 4.67 |
| low | 46.2 s / 54.3 s / 45.8 s | 11 / 13 / 11 | 4.20 / 4.18 / 4.16 |

Per-call latency was about 16% lower at `low` (mean 5.0 s vs 4.2 s); the call count depends on which links the model happens to explore, not on effort. Also measured: the same runs already batch about 2 actions per proposal (a `navigate` plus `observe`), so on this site calls track pages visited and prompt wording is not the lever. Caveats: n=3 per arm, one synthetic site with a shallow goal, and effort was not varied on a task that needs careful reading. The default stays `medium`; `plannerEffort` is a host setting, so a user who values speed can pick `low`. Not evidence that `low` is safe for harder tasks.

## Environment note

Installing Electron for these runs (`npm ci` in `apps/computer-browser`; `node_modules` is gitignored) turned five previously self-skipped real-Electron tests into failures in this sandbox: they spawn Electron as root without `--no-sandbox` (and need a Python approver venv that is absent here). They fail at Electron launch, before any harness code runs. The other 723 tests pass.

## Long: `/goal`-style persistence

`long` now keeps working until the host verifies the goal (design spec, "Goal persistence"). Mechanism-level evidence is in the unit tests, which were mutation-checked: with the rejection branch disabled, the three tests that depend on it fail; the `user`-criterion and `short`/`middle` tests correctly do not.

Real-model check (`HALO_LLM_VERIFIED=1 integration/llm-goal-run.js`, host criterion true only while the current page contains TARGET-FOUND): `middle` and `long` both completed the same way (13 planner calls, 12 actions, ~52 s). The model gathered evidence (`observe` with the criterion id) at the target page before finishing, so it never finished early and the rejection path did not fire. That means persistence was not shown to *rescue* a real premature finish here; it was shown not to interfere with a correct one, and the `goalPersistence` context reached the model without breaking its output. Whether a real model finishes prematurely often enough for this to matter is untested.

## Big task: 121-page site, `long` profile, real model, host-verified goal

`HALO_LLM_VERIFIED=1 HALO_LLM_PROFILES=long HALO_LLM_DEPTH=4 HALO_LLM_BRANCH=3 integration/llm-goal-run.js`. Site: depth 4, branching 3 (121 pages), target `r-1-0-2-1`. The only goal text was "find the page containing TARGET-FOUND; some sections are dead ends". Completion was decided by the host (criterion `verification: "host"`, true only while the browser's current page contains the marker), not by the model. Real `claude` CLI planner, immediate programmatic approval, local synthetic pages. (An earlier attempt at this run was lost when the container restarted; this is the rerun.)

| metric | value |
|---|---:|
| end state | `completed` (host-verified) |
| wall time | 407 s |
| planner calls | 89 (median 4.1 s, mean 4.6 s, max 10.5 s) |
| actions | 103 (65 navigate, 30 follow_link, 8 observe) |
| pages visited | 87 unique, 0 revisits |
| proposals by size | 76 × 1 action, 9 × 2, 3 × 3 (mean 1.2) |
| rejected finishes | 0 (one `finish`, accepted) |
| journal fsyncs | 105 |

What it shows, and what it does not:
- The harness carried a real model through a ~7-minute, 89-call task and completed it with a host-verified result. The run crossed three context segments (25 planner calls per segment) with the goal intact, and navigation memory prevented any revisit.
- Time is planner latency: 89 calls × ~4.6 s ≈ 409 s of the 407 s wall time. Harness cost is not visible at this scale.
- The model was not efficient: in-order depth-first search reaches the target after 54 pages; it loaded 87 (+61%). It never batched meaningfully (mean 1.2 actions per proposal), so `long`'s cap of 3 was not the constraint.
- Goal persistence did not fire: the model finished once, correctly. One run on one site; it does not measure how often a model finishes early or how often it fails outright.
