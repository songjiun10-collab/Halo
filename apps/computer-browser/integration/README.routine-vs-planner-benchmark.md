# Routine vs. planner benchmark

Paired, randomized comparison of the two proposal sources on the same deterministic local page chain. Both modes share the Electron build, `BrowserAdapter`, `TaskController`, `TaskStore`, approval path, viewport and success criterion (`verification: "user"`, so both end in `awaiting_verification`). Only the proposal source differs: a saved routine (`RoutineRunner`) versus the scripted planner worker (`fixtures/scripted-planner-100.js`).

## Run

From `apps/computer-browser`:

```bash
HALO_BENCH_STEPS=50 HALO_BENCH_PAIRS=6 node_modules/.bin/electron integration/routine-vs-planner-benchmark.js
```

| Env | Default | Range |
| --- | --- | --- |
| `HALO_BENCH_STEPS` | 50 | 2..64 (routine step cap) |
| `HALO_BENCH_PAIRS` | 6 | 2..200 |
| `HALO_BENCH_SEED` | 1 | schedule/order seed |
| `HALO_BENCH_APPROVAL` | `review` | `review` (every action queued and approved) or `allow` |
| `HALO_BENCH_SCROLLS_PER_PAGE` | 0 | 0..5 scrolls after every non-final page (routine cap: steps + scrolls x (steps - 1) <= 64) |
| `HALO_BENCH_BATCHING` | `on` | `on`/`off`: toggles `TaskController` read-only batching (`batchReadOnlyActions`); only matters when scrolls are enabled |

Output is one `RESULT_JSON:<json>` line (`schemaVersion: 1`); exit code is nonzero if any iteration diverges from the shared scenario (fail closed). The report-shape smoke test runs under plain `npm test` with a fake browser: `test/routine-vs-planner-benchmark.test.js`.

## Report fields

- `design`: pairs, seed, approval mode, per-pair mode order. The first pair is labelled `cold`, the rest `warm`.
- `summary.{routine,planner}.{cold,warm}`: p50/p95 of run time, cleanup, planner startup (planner only, reported separately), first proposal call, per-proposal round trip, action/proposal/approval/policy counts, and per-stage totals for policy decision, approver decision, the inclusive `controller.approve()` call, proposal, browser observe/execute, journal preparation/write/fsync, and checkpoint write/fsync/rename/directory-fsync.
- `comparison.pairedRunMsDelta`: planner minus routine run time within each pair.
- `memory`: poll-sampled RSS (Electron processes plus registered planner workers) every 100 ms, split by mode.
- `fixture`: per-page request counts, which must be uniform across iterations.

## Limits

- Not a model-quality comparison: the planner is a deterministic scripted worker.
- RSS is poll-sampled and is not a hard memory ceiling.
- The historical one-shot 100-page numbers are a different, non-equivalent comparison.
- Approval is an in-process stand-in for the Python approver; neither mode goes through `TaskHost`, so host memory admission is not exercised.
- Stage timings are diagnostic spans, not mutually exclusive slices of `runMs`: TaskStore records storage-operation durations, while browser execution and `controller.approve()` can enclose journal/checkpoint work. Do not sum every stage and treat it as elapsed wall time. `approver_decision` is the fixed in-process callback, and `approve_call_inclusive` is an outer span that may include the remainder of the task run; neither is human response time.
- Percentiles are only meaningful with enough pairs; with the default 6 pairs the warm group has 5 samples, so p95 is close to the max.

## Measured run (2026-09-29)

Command: `HALO_BENCH_STEPS=50 HALO_BENCH_PAIRS=6 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=review node_modules/.bin/electron integration/routine-vs-planner-benchmark.js` on Electron 44.4.5 / Node 24.21.0 / macOS arm64. All 12 iterations succeeded and the local fixture served a uniform 12 requests per page. Pair order was counterbalanced (3 routine-first, 3 planner-first).

| Measure | Routine | Scripted planner |
| --- | ---: | ---: |
| Warm run p50 (n=5) | 1,550.3 ms | 1,180.2 ms |
| Warm run p95 (nearest-rank, n=5) | 1,573.2 ms | 1,213.7 ms |
| Warm first proposal p50 | 0.007 ms | 90.1 ms |
| Poll-sampled peak RSS | 505,446,400 B | 565,248,000 B |

Paired `planner - routine` run-time difference had p50 **-372.2 ms** (planner faster for this fixed scenario). The measured warm per-iteration stage p50s were:

| Stage (ms per iteration, p50 of 5 warm samples) | Routine | Scripted planner | Routine minus planner |
| --- | ---: | ---: | ---: |
| Action policy decision | 0.035 | 0.028 | +0.007 |
| In-process approver callback | 0.051 | 0.035 | +0.016 |
| Browser observe | 23.325 | 19.639 | +3.686 |
| Browser execute (includes nested work) | 376.550 | 311.200 | +65.350 |
| Journal preparation | 1.383 | 1.171 | +0.212 |
| Journal append write | 11.490 | 9.222 | +2.268 |
| Journal fsync | 360.994 | 356.551 | +4.443 |
| Checkpoint file write | 7.720 | 3.427 | +4.293 |
| Checkpoint file fsync | 366.605 | 187.283 | +179.322 |
| Checkpoint rename | 22.595 | 10.513 | +12.082 |
| Checkpoint directory fsync | 366.758 | 176.258 | +190.500 |

The two checkpoint-fsync spans together show about **369.8 ms** more routine time per warm iteration, close to the **370.1 ms** gap between the mode-level warm run p50s and the **372.2 ms** paired-delta p50. Journal fsync was nearly equal (+4.4 ms routine), so the observed durability gap is concentrated in checkpoint file and directory fsyncs, not journal append/fsync. This is strong attribution evidence, not an exact additive partition: stage p50s are separately summarized, checkpoint phases overlap enclosing browser/approval spans, and OS storage latency can vary. `approve_call_inclusive` is not an approval-latency measurement: it wraps a controller call that can await subsequent task work. This is a local scripted harness comparison, not a model-quality result or a general claim that routines are slower. The tiny five-run warm percentile groups and 100 ms memory sampling are coarse; repeat on the target workload before making a performance decision. Reducing checkpoint durability would change recovery guarantees and must not be done silently.

## After skipping the per-step cursor checkpoint (2026-09-29)

The section above predates this change: `TaskController` no longer writes a checkpoint after every routine step. The durable `routine_step_advanced` journal record is the cursor's source of truth, `streamJournalReplay` re-derives the cursor from any number of advancements after the last checkpoint (each binding-checked, and `TaskHost` verifies every recovered step digest against the pinned definition), and pause, stop and finish transitions still checkpoint. A crash mid-run therefore loses no completed step and never replays one; the only thing dropped is the per-step tmp-write/fsync/rename/dir-fsync.

Same command as above (`HALO_BENCH_STEPS=50 HALO_BENCH_PAIRS=6 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=review`), all 12 iterations succeeded, uniform 12 requests per page:

| Measure (warm, n=5) | Routine | Scripted planner |
| --- | ---: | ---: |
| Run p50 | 1,120 ms | 1,192 ms |
| Run p95 | 1,140 ms | 1,219 ms |
| Checkpoint file fsync p50 | 191 ms | 180 ms |
| Checkpoint directory fsync p50 | 187 ms | 184 ms |

Routine run p50 dropped from about 1,550 ms to 1,120 ms and the paired `planner - routine` p50 flipped to about +71 ms (routine faster). Same caveats: five warm samples, one machine, local scripted fixture.

## Read-only action batching (2026-09-29)

Design: `docs/superpowers/specs/2026-09-29-readonly-action-batching-design.md`. A proposal made only of `observe`/`scroll` actions is approved once per distinct action type and only its last action's `action_started` (and, for routines, `routine_step_advanced`) is durable; everything else in the batch is flushed by that one fsync.

Workload: 16 pages, 3 scrolls after each of the 15 non-final pages, so 61 actions per iteration in both modes (`HALO_BENCH_STEPS=16 HALO_BENCH_SCROLLS_PER_PAGE=3 HALO_BENCH_PAIRS=6 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=review`). Both modes always propose 3-scroll groups; the only factor is `HALO_BENCH_BATCHING`, which turns the controller's batch path on or off (off means the previous behavior: one approval and one durable `action_started` per action). Run order was off, on, off, on on Electron 44.4.5 / Node 24.21.0 / macOS arm64; all 24 iterations succeeded with uniform fixture requests and identical visited pages. The scripted planner derives its position from the host's `actionsUsed` budget, so it also works when review queues one action at a time.

| Measure (warm, n=5, two runs each) | Routine off | Routine on | Planner off | Planner on |
| --- | ---: | ---: | ---: | ---: |
| Run p50 | 1,277 / 1,286 ms | 689 / 693 ms | 1,324 / 1,300 ms | 738 / 754 ms |
| Run p95 | 1,290 / 1,327 ms | 717 / 758 ms | 1,402 / 1,354 ms | 749 / 778 ms |
| Journal fsyncs per iteration (exact) | 123 | 63 | 123 | 63 |
| Approver calls / queue items per iteration (exact) | 61 | 31 | 61 | 31 |
| Journal fsync span p50 | 420-424 ms | 223-224 ms | 431-434 ms | 216 ms |
| Checkpoint file fsync span p50 | 223-224 ms | 114-116 ms | 208-216 ms | 112-114 ms |

Run time dropped by about 45 percent in both modes (routine about 1,280 to 690 ms, planner about 1,310 to 745 ms). Fsync and approval counts are deterministic; timings are one machine, five warm samples per run, and the off/on runs are separate processes rather than pairs within one process.

Two caveats on attribution. First, about half of the saving comes from review: with `review` approval, one queue item per batch replaces three, and each queued item also writes a checkpoint (the checkpoint fsync span halves too), so the gain is not purely the journal fsync. Second, the scroll-heavy workload is the best case; a navigation-only chain (the earlier sections) has no read-only batches and is unchanged. After a power loss up to one batch of read-only actions may be replayed, and scroll is not idempotent.
