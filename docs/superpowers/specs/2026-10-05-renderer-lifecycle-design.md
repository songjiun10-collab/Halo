# Renderer lifecycle: agent count != live renderer count

Status: draft for review. Date: 2026-10-05.

## Problem

Halo's beta must survive users who run ~20 agents, ~80 tabs, ~10 background tasks and several Teams at once, without Halo capping the agent count artificially. Today every agent and tab owns a live Chromium renderer, so renderer count and memory grow linearly with agent and tab count. The only defences are admission caps: `maxParallelTasks` (default 2, max 8, `task-host.js:101,241`), a 2 GB hard memory cap with pause at 80% and emergency stop at 90% (`memory-monitor.js:21-24`), and a 200 MB reserve per child agent (`child-agent-coordinator.js:61`).

### What exists today (verified in code)

| Unit | Live renderers / windows | Where |
|---|---|---|
| Top-level task | 2 `WebContentsView` (visible view + hidden agent view) + 1 hidden `BrowserWindow` | `main/index.js:388` (`makeHarnessBrowser`), `agent-viewport-host.js:105-122` |
| Child agent | 1 hidden view + 1 hidden window + its own planner worker subtree | `child-agent-coordinator.js:61`, `agent-viewport-host.js:247` |
| User tab | 1 view, always live; no discard/freeze path | `control-api.js:225-258`, `control-api.js:462-481` |

The task's visible view is never driven by the agent: `makeDualSurfaceBrowser` routes `observe`/`execute` to the hidden agent adapter only (`agent-viewport-host.js:340-377`). The visible view is created at attach, but it stays an unloaded view (no renderer process) until the user takes over.

Existing seams to build on:
- A user tab is already a record `{ id, title, url, view }`; the view can be dropped while the record stays.
- `AgentViewportHost.ensure()/dispose()` and `TaskHost` re-attachment (`needsReattach`, after `memory_emergency`) already implement "dispose the browser, mint a fresh one later" (`task-host.js:2065-2080`).
- Observations carry `documentEpoch` and a stale-observation check (`stale_visual_observation`), so an action based on an observation from before a renderer swap is already rejected.
- Task sessions are partitions (`halo-task-<id>`, agent partitions): the session outlives a renderer.

## Measured facts that shape the design

- Stock Electron 44.4.5 (Chromium 152) plays video with 0 dropped frames, hardware decode on, with a hidden offscreen view and with the vibrancy window. Chromium itself is not the lag source.
- A hidden offscreen view plus `capturePage()` every 600 ms costs ~16 ms per capture and no measurable main-thread lag.
- Vibrancy raises `WindowServer` CPU by ~10 points. It stays (product decision); it is not a target of this work.
- YouTube 1080p60 in one Halo tab: ~450-1000 MB renderer, ~800 MB-1 GB total. Per-renderer cost for typical pages under load is **not yet measured** (Phase 0).

## Goals

1. Live renderer count is set by a memory budget and by what is actively being used, not by agent or tab count.
2. No artificial cap on agents or tabs. Excess agents and tabs are parked, not refused.
3. Parking and restoring is safe: no action runs against a page that is not the page the planner observed.
4. No regression for the page the user is looking at (smooth video, input latency).

## Non-goals

- Replacing Electron or forking Chromium (see Decision gate).
- Removing vibrancy.
- Changing planner behaviour, approval policy or the permission model.
- Preserving arbitrary in-page JS state across a park (see Limits).

## Design

### Concepts

- **BrowserSession** (logical, cheap): the thing an agent or tab owns. Holds partition name, current URL, title, last scroll position, a short capture of the last observation (url, `documentEpoch` at capture), and a state: `live | parked | disposed`.
- **Renderer lease**: a `BrowserSession` in state `live` holds exactly one `WebContentsView`. Leases come from the **RendererPool**.
- **RendererPool**: owns the live views. Capacity is derived from the memory budget (`MemoryMonitor` real process memory) and a max live-renderer count, not from agent count. Eviction is LRU among sessions that are not pinned.
- **Pinned** (never evicted): the tab the user is viewing; a session with an in-flight `execute()`; a session whose page is playing audio/video the user can hear; a session holding unsaved form input detected by the page script (Phase 3).

### Park and restore

- **Park**: record URL, title, scroll position and the capture; destroy the view (`webContents.close()`); keep the partition so cookies and storage remain; state becomes `parked`.
- **Restore**: acquire a lease, create a view on the same partition, load the URL, wait for load, then restore scroll. Bump `documentEpoch` so every earlier observation is stale and the planner re-observes before acting.
- An agent parks its session whenever it is waiting on the planner, on approval, or in the background with nothing to do, and restores on the next `observe()`/`execute()`.

### User tabs

- Tabs keep `{ id, title, url }` plus an optional view. Inactive tabs become `discarded` (view destroyed) after an idle timeout or on memory pressure, in LRU order. Selecting a discarded tab restores it. Never discard the active tab, an audible tab, or a tab with a pending download or `beforeunload` handler.

### Structural reductions that need no new concept

1. ~~Create a task's visible view lazily.~~ Dropped after measurement (2026-10-06): a `WebContentsView` that never loads a URL spawns no renderer process (10 blank views: +1 MB each, process count unchanged); the task's visible view is only loaded on user takeover (`userNavigate`), because `observe`/`execute` go to the hidden agent adapter. Loading `about:blank` costs ~80 MB and one process per view, which is what the agent views already pay. So the per-task renderer count is 1, not 2, and the savings are in parking agent views (Phase 2), not in the visible view.
2. One shared hidden `BrowserWindow` for all agent views instead of one per view.
3. Stop painting for hidden agent views whenever no capture is requested.

### Admission

`maxParallelTasks` stops being a renderer/memory guard. It becomes a limit on concurrently *planner-active* tasks (planner worker processes), tunable. Memory admission is on live-renderer budget: if no lease can be granted after evicting unpinned sessions, the requester waits in a FIFO queue; it is not rejected.

### Safety invariants

- Intent Lock, permission mode and the agent request filter attach to the session, not to a view, and are re-applied on every restore (`makeDualSurfaceBrowser` forwards these to the agent adapter; the adapter must re-bind to the new view).
- An approval request names the session and `documentEpoch`; a restore between request and decision invalidates it, so the user re-approves against the current page.
- Restoring never replays user input, form submissions or downloads. Only a GET navigation to the saved URL.
- A park or restore is journaled so the task checkpoint and the host journal stay consistent.

### Companion change: agent mirror

While an agent works, the user's native view is replaced by a still refreshed on a timer (`frontend/src/App.tsx`, `!agentFrame` hides the native surface). The mirror stays a replacement of the native view, not a picture-in-picture panel. Two changes make it cheap and smooth:

- Refresh every 250 ms instead of 600 ms. Measured with 10 windows (5 video, 5 working): 0 dropped frames, main-thread lag max 68 ms.
- Deduplicate frames: `AgentViewportHost.captureFrame` fingerprints a 64 px downscale (sha1 of the bitmap) and returns the cached JPEG when the page has not changed, so an idle agent page costs no re-encode and no new IPC payload.

Status: the fingerprint and the 250 ms interval are implemented in the working tree but depend on the uncommitted mirror feature, so they ship with it. Separate from the pool work.

## Beta scope decision (2026-10-06)

The beta ships on Phase 1 plus reclaim-before-refuse. Agent-view park/restore (Phase 2) is deferred until a measured target is missed.

Why: `BrowserAdapter` binds to one `WebContentsView` for its lifetime (listeners, `_documentEpoch`, interaction and visual bindings, the Intent Lock). Parking means re-binding a live adapter to a new view, or swapping the adapter under a running `TaskController`, in the class that enforces effect safety. A restore bug there could replay or misdirect an action; a missed memory target only queues a task. The epoch machinery already makes a restore safe in principle (`did-navigate` bumps `_documentEpoch` and clears the bindings, so any observation or approval from before is rejected as stale), but that has to be proven by tests before it ships, which is more risk than a beta needs.

What protects the beta today: memory admission (queue, never reject), reclaim of inactive tabs before refusing, a visible wait reason, sequential execution by default, and the 2 GB hard cap.

Revisit when: a 20-task, 80-tab run on a 16 GB Mac misses the provisional targets, or users hit "Waiting for memory" often with no tab left to reclaim.

## Limits (stated honestly)

- A parked page loses JS state: SPA in-memory state, open modals, unsent form text, media position, WebSocket connections. The restore reloads the URL. Phase 3 adds a capture for form fields and scroll to soften this; it never makes restore transparent.
- Pages that need a live connection (chat, collaborative editors, video calls) must be pinned or accept reload.
- Restore adds latency (a page load). Measured in Phase 0 and shown to the planner as a normal navigation.
- Planner worker processes (one subtree per child agent) are a second linear cost; they are pooled in Phase 4.

## Phases

- **Phase 0 (measure)**: local mock-server harness that opens N agent views and M tab views in an isolated Electron, records process count and memory live vs parked, with and without a shared hidden window. Sets the provisional numbers below. No product code changes.
- **Phase 1 (low risk, biggest win)**: lazy visible view, shared hidden window, `stopPainting` for hidden agent views, user-tab discard and restore, agent mirror as picture-in-picture.
- **Phase 2**: BrowserSession and RendererPool for agent views, with park and restore, epoch bump and approval invalidation. Admission by live-renderer budget.
- **Phase 3**: pinning rules (audible, in-flight, form input) and the form/scroll capture.
- **Phase 4**: planner worker pooling; Teams.

### Provisional targets (calibrated after Phase 0)

With 20 agents and 80 tabs open on a 16 GB Mac: live renderers at most 12 plus pinned ones; total Halo memory at most 4 GB; the focused tab's video shows 0 dropped frames while 10 background agents run; restore of a parked page to a usable observation under 3 s on a typical page.

## Decision gate: custom Electron build or Chromium

Move beyond Electron-level pooling only if, after Phase 2, a measured target is missed and the cause is a capability Electron does not expose. Candidates: renderer freeze that preserves page state (Chromium keeps tab freeze/discard in `chrome/`, which Electron does not include), changing the process model, or an agent rendering path that produces no compositor frames. The order of cost: Electron pooling, then Electron built from source with patches, then Chromium with a new app shell. Vibrancy and the React shell are unaffected by either of the first two.

## Testing

- Unit: pool eviction order, pinning, queueing instead of rejecting, session state machine, epoch bump on restore, approval invalidation across restore.
- Integration (isolated Electron, localhost mock pages): park and restore keeps cookies from the partition; restore never replays a form post; a stale observation is rejected after restore.
- Scale test: Phase 0 harness at 20 agents and 80 tabs, asserting the provisional targets.
- Regression: focused-tab video dropped frames stays 0 with background agents running.

## Open questions

1. Idle timeout for tab discard (proposal: 10 minutes, and immediately under memory pressure).
2. Whether Teams share a hidden window per team or globally (proposal: global, sessions isolated by partition).
3. Whether to expose "pin this tab/agent" to the user in Phase 2 or Phase 3.

## Phase 2 implemented (2026-10-06)

The deferral above is lifted by the product owner. Agent surfaces now follow ACTIVE, FROZEN, DISCARDED
(`apps/computer-browser/runtime-src/main/harness/renderer-lifecycle.ts`).

- `ParkableView` is the stable view the adapter binds to. Its `webContents` forwards the live renderer's events, so
  `BrowserAdapter` is unchanged. A discard keeps the URL and title and releases the renderer; the partition keeps the
  session. A restore loads the saved URL only, which fires `did-navigate`, so the adapter bumps its epoch and drops every
  earlier observation and approval binding. Synchronous input never wakes a surface (it fails closed).
- The host wakes a surface before `observe`/`execute`/screenshot calls (`wakeOnUse`), so the restore's navigation never
  lands inside an observation in flight. Surfaces start parked and get a renderer on first use.
- `SurfacePool` freezes idle surfaces (`Page.setWebLifecycleState`), discards the least recently used ones beyond a cap
  (default 6) and anything idle for 2 minutes, never touches a surface mid-call or pinned, and gives memory back on demand
  (`relieve("soft"|"hard")`, called from memory admission before a task is refused).
- Off by default in `AgentViewportHost`; `main/index.js` turns it on.

Measured (16 GB M5, 30 logical agents, one page each, run in waves of 5, cap 5):

| | peak RSS | steady, 5 live | restore + observe |
|---|---|---|---|
| Electron 44 | 1.5 GB | 0.9 GB | 88 ms |
| Chromium 157 Trial (component build) | 8.7 GB | 4.0 GB | about 2.3 s |

Without the pool the same 30 agents scale linearly (10 agents: Electron 1.4 GB, Chromium 6.1-6.5 GB). Freezing saves CPU, not
RSS. On Chromium a closed renderer takes 20-40 s to exit, so a discard is not instant relief there.
Limits: a restore reloads the URL, so in-page JS state, unsent form text and history entries are lost; the live-renderer
cap and idle timers are provisional.
