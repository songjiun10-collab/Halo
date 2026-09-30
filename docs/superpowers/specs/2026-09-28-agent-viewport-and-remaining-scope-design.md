# HALO agent viewport and remaining scope design

Date: 2026-09-28  
Status: design for review; no runtime implementation authorized by this document alone  
Owner: HALO host; renderer is an untrusted request/observation surface

## Goal

Add a stable 1440x900 agent viewport and background-tab behavior without changing
the user's visible page geometry, allowing page code to steal foreground focus,
or weakening the existing host-owned goal, journal, independent approver,
provenance, approval invalidation, and uncertain-execution boundaries. Preserve
the measured aggregate process-memory ceiling of 1 GiB as a hard acceptance
criterion, not a marketing claim.

This document also orders the remaining Aside-inspired scope. It does not claim
feature parity with Aside.

## Current checkout facts

- `BrowserSurfaces` currently manages one visible `WebContentsView` per task,
  lays it out to the renderer-provided responsive bounds, and hides other task
  views. The same view is the `BrowserAdapter` execution target.
- Renderer already sends viewport bounds with `setTaskViewport`; the API is
  exposed by preload/IPC. The browser element is `#hx-page` in `frontend/src/App.tsx`.
- `MemoryMonitor` accounts for Electron processes and explicitly registered
  approver/planner processes. Any additional agent renderer must be registered
  and included in sampling before use.
- Existing approval/takeover UI and task journal exist. Task snapshots currently
  report task, goal, queue, and browser state; they do not have an agent-surface
  lifecycle or broker capability state.

## Decision: one reusable agent-only view, with explicit ownership

Create at most one host-owned agent `WebContentsView` for the active task. It is
not attached to the visible window's content tree while the agent is operating;
it uses a fixed 1440x900 viewport and is never a renderer-controlled coordinate
surface. The existing user-visible page remains responsive and independent.

The agent view is the sole execution target for autonomous actions. User-visible
pages are not silently mutated by that view. HALO may copy a URL or a bounded,
sanitized observation to the user surface, but must not claim DOM/runtime state
is mirrored. On takeover, HALO pauses and drains in-flight dispatch, then gives
the user an explicit choice to open the agent page in the visible browser surface
or continue in a separate user tab. Switching ownership invalidates pending
approvals and increments the document epoch; it never replays an uncertain
action automatically.

The view may be reused only for the same active task and browser session. It is
destroyed on task stop/completion, host shutdown, memory emergency, or task/session
switch. This avoids accumulating background tabs and renderers. Agent viewport
coordinates always remain 1440x900; if shown during takeover, the visible UI may
scale/letterbox the captured page but must make that presentation explicit and
must not translate user clicks into agent coordinates without a reviewed mapping.

### Browser session/cookie boundary

The initial implementation must use the task's existing Electron session
partition, so login state is shared with the task's existing browser surface.
This is a sensitive capability and must be called out in UI and docs. Do not
copy cookies, local storage, passwords, or session tokens through renderer IPC,
the model context, journal, or screenshots. A later isolated profile mode is
out of scope for this first slice.

### Focus and background behavior

- Autonomous navigation/actions happen only in the agent-only view.
- Creating, navigating, showing, or destroying that view must not activate or
  focus a window, tab, or WebContents belonging to the user.
- Popup, download, permission, and external-protocol events fail closed and are
  surfaced as typed host events; they do not auto-open or auto-download.
- When the view is not active, suspend/park or destroy it according to the
  measured memory budget; no unbounded hidden tab collection.
- Takeover is a durable ownership transition: close admission synchronously,
  drain dispatch, write the transition, invalidate approvals, then expose the
  selected surface. On persistence failure, remain fail-closed and show the
  user that takeover did not complete.

## Memory and performance gates

The agent view is not accepted until repeatable same-journey measurement samples
the aggregate Electron process tree plus planner and approver. Report p50/p95
latency, peak aggregate memory, sample interval/coverage, cold/warm cases, and
failure/recovery behavior. Include the new renderer PID in `MemoryMonitor` and
prove registration/unregistration through tests. If a realistic run approaches
the 1 GiB cap, the implementation must prefer task pause/teardown over starting
another renderer. No claim of being faster than browser-only is allowed unless
the workloads and measured stage boundaries are comparable.

## Security and lifecycle invariants

1. Renderer can request UI actions but cannot construct a WebContents, choose a
   partition, or grant itself credentials.
2. `BrowserAdapter` actions are bound to the active task, current goal version,
   active document epoch, and current observation.
3. Approvals are invalidated on task/session/view ownership changes and never
   survive process recovery.
4. Agent-generated page content remains untrusted. A trusted-looking URL or
   planner self-report is not authorization.
5. Unknown popup, download, permission, certificate, and protocol events do not
   widen capabilities.
6. If view identity, process identity, document epoch, or durable transition
   cannot be established, pause rather than guess.

## Frontend contract needed

The renderer should not manage the agent WebContents directly. It needs only
typed state and explicit user controls:

- `agentSurface`: `idle | starting | running | waiting | paused | failed`, plus
  `viewport: {width: 1440, height: 900}`, task ID, current URL/origin, and a
  non-secret reason/status code.
- An agent activity indicator in the tab/task header, visibly distinct from the
  user's active page; it must say when the agent is working in a separate page.
- A fixed-viewport disclosure and “Show agent page / Take over” control. Showing
  the page and transferring control are distinct actions; do not auto-take-over.
- A live task timeline row for `agent_view_started`, `agent_view_closed`,
  `takeover_requested`, `takeover_completed`, and `takeover_failed`, with
  timestamps and safe error codes. No page body, cookies, or secret values in
  timeline payloads.
- A typed popup/download/permission blocked notice with an explicit review path.
- Memory-pressure/renderer-crash state with `execution_uncertain` where relevant,
  a safe resume/re-observe action, and no “retry” that silently repeats an action.
- Responsive layout for mobile widths: show status and actions, not a shrunken
  fake 1440x900 interactive viewport. The agent page can be opened as a separate
  user page after explicit selection.
- Accessibility: keyboard-operable controls, announced status updates, focus
  restoration after approval/takeover, and no color-only status semantics.

No credential entry, secret value, or autofill toggle belongs in the renderer.
Credential broker UI, if later approved, can request a scoped one-time use and
show origin/field intent, never the secret itself.

## Remaining scope order

1. **P0: agent viewport/background isolation.** Implement only after this design
   is reviewed, including Electron integration and memory/focus tests.
2. **P1: credential broker threat model and prototype.** Separate design first:
   OS keychain storage, exact-origin/field scope, one-shot host capability,
   explicit approval, no secret in model/journal/renderer, navigation race
   invalidation, and exfiltration limits. Do not equate autofill with safe use.
3. **P1: local task memory.** Begin with structured local task index/search over
   user-authored goals and verified artifacts only; page text and model summaries
   remain untrusted and opt-in. Define retention/deletion/export before semantic
   embeddings.
4. **P2: remote/mobile approval.** Reuse signed, expiring, task-bound approval
   requests; design replay protection and device pairing before transport. No
   network listener or cloud sync in the viewport slice.
5. **P2: browser sync.** Out of scope until local data classification, encryption,
   conflict semantics, and account recovery are specified.

## Alternatives considered

- Force 1440x900 CDP metrics on the currently visible task view: rejected because
  it couples agent layout to the user's responsive page and confuses coordinates.
- Fork Chromium / patch Blink as Aside does: rejected for this phase because it
  expands maintenance and security-update surface beyond the Electron prototype.
- One hidden agent view per task: rejected because renderer count and memory grow
  with task history, violating the under-1-GiB target.

## Acceptance tests for implementation phase

- Fixed viewport remains 1440x900 across window resize and user foreground page
  changes; visible page remains responsive.
- Background agent navigation does not focus/activate the app or change the
  selected user tab.
- Exactly one agent renderer is created and destroyed/reused only as specified;
  process accounting sees its PID and no stale surface survives task switch.
- Takeover races against approval, pause, stop, and navigation: stale approvals
  fail; no action dispatches after takeover admission closes; checkpoint failure
  leaves control hidden and retryable.
- Popup/download/permission requests fail closed and emit safe timeline events.
- Crash during dispatch recovers as uncertain; no automatic replay.
- Full Electron integration suite passes; same-journey aggregate memory run stays
  under 1 GiB with an explicit safety margin and complete process coverage.

## Review checklist / unresolved questions

- Initial local probe on the pinned Electron 44.4.5 verified a hidden 1440x900
  `BrowserWindow` host with a `WebContentsView` reports `innerWidth` /
  `innerHeight` and document client size exactly 1440x900. A 3-second,
  250-ms-sample Electron-process-only run peaked at 360,726,528 bytes across
  Browser/GPU/Utility/Tab processes. This excludes the rest of the product,
  external planner/approver, longer workloads, and cold-start transients; it is
  feasibility evidence only, not proof of the 1-GiB product budget.
- Still verify hidden-view lifecycle, background throttling, fixed viewport,
  and CDP device-metrics behavior for the repository's pinned Electron version
  in a product-level integration before implementation.
- Verify whether sharing the task's current persistent partition meets the user's
  expected login/cookie behavior; changing this changes product semantics.
- Decide how the agent page is exposed on takeover without implying live
  mirroring. Recommended: explicit “open agent page” action that navigates a
  selected user tab to the URL after takeover, with a warning that page runtime
  state may differ.
- Establish a 1-GiB acceptance margin (recommended pause threshold remains the
  existing 800-MiB policy) and capture complete process-tree samples.

**2026-09-28 follow-up — memory/performance gate evidence:**
`apps/computer-browser/integration/agent-viewport-memory-electron.js` (run
via `apps/computer-browser/test/agent-viewport-memory-integration.test.js`,
part of the regular `node --test` suite) is real-Electron, product-code
evidence for this section, wired exactly as `main/index.js`'s
`makeHarnessBrowser` composes `AgentViewportHost` +
`makeDualSurfaceBrowser` in production: a real Python approver, a real
scripted planner child process, and a real hidden 1440x900 agent renderer
driven through `fixtures/long-horizon-site.js`'s 3-page journey across
several real context resets, plus a second task's fresh renderer. Measured
(three consecutive real runs, this checkout, 2026-09-28): peak aggregate
process-tree memory ~530 MB against the 1 GB cap; agent-renderer cold start
~422 MB vs. steady-state warm ~467 MB after further real page loads on the
SAME reused renderer (`ensure()`'s reuse contract holding under a driven
journey, not just a synchronous double-call); a second task's fresh
renderer at ~377 MB with zero stale pids from the first task's already-
disposed renderer in its own sample ("no stale surface survives task
switch"); a genuine `webContents.forcefullyCrashRenderer()` against the
hidden agent view reclaimed the crashed pid's memory and left
`AgentViewportHost.dispose()` non-throwing against the real crashed
`webContents`. Latency (p50/p95, ms, one representative run): browser
observe 1.5/1.8, browser execute 8.5/160 (execute includes real page
navigation/settle time), durable store append+checkpoint 3.0/12, planner
round trip 0.4/139 (includes real child-process JSONL round trips), approver
round trip 0.5/0.6 (real Unix-socket round trip to the Python process). This
answers the "verify hidden-view lifecycle... in a product-level integration"
and "capture complete process-tree samples" items above for the currently
implemented per-task-scoped agent view (see agent-viewport-host.js's own
scope note on why per-task, not single-global-instance, is what is actually
implemented); it does not cover background throttling behavior or
CDP-device-metrics edge cases beyond the fixed-viewport check already in
`agent-viewport-lifecycle-electron.js`.
