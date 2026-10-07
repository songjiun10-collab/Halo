# Backend computer-use: DOM-first observation and JPEG delivery

## Scope

The host uses existing isolated-world DOM observation and approved action adapters. This change does not grant the planner raw CDP sessions or arbitrary JavaScript execution. Approval, task/observation/document-epoch binding and uncertain-execution handling remain in place.

- Image-capable planners receive text targets first when the DOM map is not sparse. Images remain the fallback for sparse maps or definitely failed DOM actions; uncertain actions do not trigger automatic re-execution.
- Host screen mirrors request one resized JPEG directly from Chromium, instead of capturing PNG and then capturing JPEG again. Concurrent identical requests share only an in-flight promise; no historical screenshot is reused.
- Navigation during capture, destroyed/replaced views and invalid/oversized JPEG buffers are rejected.
- Viewport resize operations are serialized and JPEG capture waits for pending resize completion.
- Parkable surfaces forward direct JPEG only when supported and pin the renderer while capture runs.
- Backend input requiring effect checks is not sent when the pre-action snapshot is unavailable. Post-action effects remain heuristic; a changed page is not proof that the user's business objective succeeded.
- Initial Chromium readiness is awaited before a parkable adapter starts its navigation deadline. Hardening is not skipped to save time.

## Reproducible frame benchmark

Run from `apps/computer-browser`: `node integration/computer-use-capture-benchmark.ts`.

Disposable localhost fixture at the default 1280×800 viewport, 16 paired samples, alternating order, equal warm-up. No model/API calls or user credentials. Measurements exclude startup. The initial JSON fixture label incorrectly said 1440×900; the script label is corrected without changing capture behavior.

| Metric | Legacy PNG then JPEG | Direct JPEG |
| --- | ---: | ---: |
| Isolated run p50 | 136.4 ms | 49.7 ms |
| Isolated run p95 | 172.4 ms | 63.8 ms |
| Run overlapping regression load p50 | 169.4 ms | 60.1 ms |
| Run overlapping regression load p95 | 247.3 ms | 155.7 ms |
| Screenshot calls / 16 samples | 32 | 16 |
| Mean transport image bytes | 284,356 | 109,304 |
| Mean delivered JPEG bytes | 109,304 | 109,304 |

All 16 pairs produced identical JPEG bytes in each run. A deterministic localhost field/button operation through the backend isolated-world API also verified its resulting title and value. Neither check measures model accuracy, cross-site task success or end-to-end speed.

## Verification status

New routing/capture tests cover rich DOM, sparse fallback, text-only models, stale bindings, uncertain actions, disposal, navigation, bounds, single-flight failures, viewport races, initial readiness and parkable forwarding. Final focused run: **50 pass, 0 fail**, including actual Chromium freeze/discard/restart tests. Fresh TypeScript, generated-runtime consistency and diff whitespace checks passed. The full repository run was interrupted after discovering another contributor's concurrent full suite; full regression remains unverified. Detailed evidence is tracked in `.planning/2026-10-07-computer-use-speed/progress.md`.

No commit or push performed. Concurrent contributors' unrelated changes are preserved.

## Follow-up: immediate effect verification

The user approved removing the first fixed 100 ms verification delay. `effect-verifier.ts` now reads once immediately, and then retains all existing delayed polls if no change is observed. Unreadable/failed reads never imply success. No actions are retried, approval rules are unchanged and the same-site navigation interval remains 1500 ms.

Red/green regressions cover an already-visible effect, an unreadable immediate snapshot and the final delayed poll. A rejected-read regression confirms unchanged pages remain unverified through the full polling window. Final related run: **27 pass, 0 fail**. TypeScript, generated-runtime consistency and whitespace checks passed. A full suite was already running in the other contributor's session, so no concurrent full run was started and no full-suite claim is made for this follow-up.

Reproduce from `apps/computer-browser`: `node integration/effect-verification-benchmark.ts`. This uses a disposable localhost Chromium page and a deterministic host-built button action, alternating old/new order across 12 pairs. All 24 outcomes were independently checked against the expected title.

| Verification latency | Frozen previous algorithm | Immediate first read |
| --- | ---: | ---: |
| p50, n=12 | 103.473 ms | 0.898 ms |
| p95, n=12 | 107.838 ms | 1.332 ms |

Input dispatch and startup are excluded. The measurements demonstrate removal of an unnecessary delay for already-visible effects, not general model accuracy or E2E speed. Delayed effects still wait for observation. The effect predicate remains heuristic and cannot prove business-level completion.

## Follow-up: independent turn-memory reads

The approved bounded change starts required local-memory and optional activity-history reads together using `turn-memory-preparation.ts`. The controller still merges required memory, branch results, then history; treats them as untrusted; checks the task epoch before planner admission; and pauses on required-memory failure. Optional failures are handled immediately, including detached reads after takeover. No browser operations, approvals or journal writes are parallelized. Reads are fresh each turn; no action is retried.

Six regression tests cover overlap, optional failure, required failure, takeover, fresh per-turn context and a stalled optional read after required failure. The original overlap regression failed before implementation. The six-test focused run passed. The broader controller/timing run before adding the final two tests passed 98 tests.

Reproduce from `apps/computer-browser`: `node integration/turn-memory-benchmark.ts`. Real local store implementations, 20 entries per source, ephemeral AES fixture encryption (not macOS Keychain), 24 alternating-order pairs per scenario. Every pair returned identical context.

| Source preparation only | Sequential p50 / p95 | Parallel p50 / p95 |
| --- | ---: | ---: |
| Local files, no injected delay | 0.752 / 1.896 ms | 0.573 / 1.011 ms |
| Local files plus synthetic 40 ms per source | 83.903 / 111.765 ms | 42.193 / 100.389 ms |

The actual local-file median gain is only 0.179 ms. The synthetic case demonstrates overlap for slow sources, not whole-task or model speed. These measurements do not establish superiority over Aside.

Full regression completed: **1964 tests, 1958 pass, 6 fail**, 548.9 seconds. Four failures involved real Chromium startup/navigation, including `cdp_timeout: Page.enable`. All four passed on isolated/sequential rechecks: AgentViewportHost 1/1 (24.7 seconds), remaining cases 3/3 (36.3 seconds). This suggests execution-load sensitivity but does not establish a root cause; no deadlines or security checks were relaxed. Two text-computer-use tests retained obsolete expectations: dense image-capable planners now legitimately use text, and Enter success requires effect evidence. Updated fixtures assert dense text, missing sparse-image failure and independent post-input evidence. Fresh focused run: **133 pass, 0 fail**. Fresh typecheck, generated-runtime consistency and whitespace checks passed. The complete suite has not been rerun after fixture corrections; therefore full-suite green remains unclaimed. No commit or push performed.
