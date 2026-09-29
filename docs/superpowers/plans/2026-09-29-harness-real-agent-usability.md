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

## Environment note

Installing Electron for these runs (`npm ci` in `apps/computer-browser`; `node_modules` is gitignored) turned five previously self-skipped real-Electron tests into failures in this sandbox: they spawn Electron as root without `--no-sandbox` (and need a Python approver venv that is absent here). They fail at Electron launch, before any harness code runs. The other 723 tests pass.

## Long: `/goal`-style persistence

`long` now keeps working until the host verifies the goal (design spec, "Goal persistence"). Mechanism-level evidence is in the unit tests, which were mutation-checked: with the rejection branch disabled, the three tests that depend on it fail; the `user`-criterion and `short`/`middle` tests correctly do not.

Real-model check (`HALO_LLM_VERIFIED=1 integration/llm-goal-run.js`, host criterion true only while the current page contains TARGET-FOUND): `middle` and `long` both completed the same way (13 planner calls, 12 actions, ~52 s). The model gathered evidence (`observe` with the criterion id) at the target page before finishing, so it never finished early and the rejection path did not fire. That means persistence was not shown to *rescue* a real premature finish here; it was shown not to interfere with a correct one, and the `goalPersistence` context reached the model without breaking its output. Whether a real model finishes prematurely often enough for this to matter is untested.
