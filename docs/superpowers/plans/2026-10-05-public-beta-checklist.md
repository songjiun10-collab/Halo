# Public beta checklist (Mac app download)

Date: 2026-10-05
Decision: Mac app download. Packaging, signing and notarization are excluded for now (user: "ㄴㄴ 패키징"); this list covers everything else.

## Blockers (fix before anyone outside tries it)

| Item | State | Owner |
|---|---|---|
| Test suite is green | 34 of 1802 fail. They come from the in-progress strategy-learning work (`host-settings`, background-service main tests, runtime build gate), not from Computer Use. | Whoever lands strategy-learning |
| Tree is committed | Uncommitted: live agent view (`agent-viewport-host.js`, `ipc.js`, `preload/index.js`, `index.js`, `App.tsx`, `api.ts`) mixed with strategy-learning hunks in the same files. | Commit together once strategy-learning is stable |
| Exposed NVIDIA API key | Must be rotated. Cannot be done from here. | User |
| Repo root hygiene | About 40 `exploit_*`, `deep_exploit_*`, `probe_*`, `*_FINDINGS*.md`, `_debug.txt`, `_stage*.txt` files sit at the root of the repo. Decide: move under `redteam/` or `docs/reviews/`, or keep private. Check them for secrets before the repo goes public. | User decision, then Claude |
| Computer Use finish loop | Fixed in the working tree (uncommitted): the click hit the right element all along; the small planner just could not tell it had worked. The host now tells it "last click succeeded" and the click-only task ends in `awaiting_verification` after one click. Still to check: other planners and multi-step tasks. | Claude (commit with strategy-learning) |
| Recovered tasks pile up | Every restart turns each unfinished task into a paused "recovered" entry at the head of the FIFO. After many restarts the list had 35 of them. Creating a new task skips them, but a person who only resumes sees the queue blocked and the History list unreadable. Needs a cleanup or a "stop all recovered" action. | Claude |
| Finish card shows no result | When a task ends in `awaiting_verification` the agent view is released and the page is blank. The user is asked to confirm without seeing what the agent read (for example the page title). The card needs an evidence summary. | Claude |

## Should fix

- Live-verify Task Branches (needs a planner that emits `waitingWork` plus a pending approval; run in Interact mode).
- Decide default permission mode (Full vs Interact). Beta users should not start in Full.
- Quit behavior: closing the window keeps the app alive on macOS, and the quit prompt hides behind windows. Choose A (close window quits) or B (prompt always in front).
- Memory budget is now 2GB (was 1.5GB, originally 1GB). A heavy page such as namu.wiki still paused the task at 1.5GB. Say so in the beta notes; consider reducing the per-task page cost later. `HALO_DEBUG_ACTIONS=1` logs `[memory-pause]` with the measured total and unmeasurable processes, to find out why a pause fired below the threshold I saw in RSS.
- "Research" tasks (for example "조사해서 요약") fail at creation: `research capability is not available`. Either hide that wording route or add the capability.
- Real Codex and Antigravity logos (user SVGs).
- Dark-theme translucency check; merged approval cards; finish-card evidence summary.
- Untested by hand: Resume agent, effort slider reset, "In parallel", Go with real typing, clipboard after Share, swipe animation.

## Beta notes to ship with the build

- What it is: a browser where an agent works in a hidden page, you watch a live view, and Halo asks only on important decisions.
- Known limits: memory ceiling 2GB; unsigned build is not part of this round.
- Privacy: tasks and journals stay on the Mac under `~/Library/Application Support/halo-computer-browser`; planner calls go to the provider the user picks.
- How to report: collect the task journal (`harness-tasks/tasks/<id>/events.jsonl`) and attach it.

## Excluded for now

Packaging, code signing, notarization, auto-update, crash reporting service, WebArena benchmark.
