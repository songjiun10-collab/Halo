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

### Middle vs. Long (same Browser planner)

Use `HALO_BENCH_KIND=duration-profile` to hold the scripted Browser planner, page chain, approval mode, controller, and durable store constant while varying only the host-selected duration profile:

```bash
HALO_BENCH_KIND=duration-profile HALO_BENCH_STEPS=50 HALO_BENCH_PAIRS=6 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=review node_modules/.bin/electron integration/routine-vs-planner-benchmark.js
```

The report groups run and per-stage timings by `middle` and `long`, and now also exposes `summaryByTemperature.{profile}.{cold,warm}` so the first cold pair is not mixed into warm measurements. It includes paired `long - middle` deltas and poll-sampled RSS by duration profile. It also runs a separate synthetic TaskStore recovery probe for each profile (`HALO_BENCH_RECOVERY_ACTIONS`, default 300; `HALO_BENCH_CHECKPOINT_EVERY`, default 25): completed action events are checkpointed and replayed, then a separate open `action_started` event checks that load classifies recovery as `execution_uncertain`. This is TaskStore replay only; it does not reattach a live TaskHost, browser, or planner. The probe writes beneath the benchmark's temporary storage root and is removed at exit.

For a short wiring smoke, use `HALO_BENCH_STEPS=3 HALO_BENCH_PAIRS=2 HALO_BENCH_RECOVERY_ACTIONS=20 HALO_BENCH_CHECKPOINT_EVERY=5`. The counters/counts are deterministic; latency and RSS remain machine/load dependent.

## Middle vs. Long measurement (2026-09-29)

Corrected measurement command: `HALO_BENCH_KIND=duration-profile HALO_BENCH_STEPS=10 HALO_BENCH_PAIRS=6 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=review HALO_BENCH_RECOVERY_ACTIONS=100 HALO_BENCH_CHECKPOINT_EVERY=10 node_modules/.bin/electron integration/routine-vs-planner-benchmark.js` on Electron 44.4.5 / Node 24.21.0 / macOS arm64. All 12 iterations succeeded; all followed the same 10-page chain, with exactly 12 fixture requests per page. There was one cold pair and five warm pairs; among the warm pairs, order was counterbalanced (2 Middle-first, 3 Long-first). The table excludes the cold pair for latency values; all p50/p95 values use five warm observations, and nearest-rank p95 is therefore the maximum. These are small-sample diagnostics, not a performance claim.

| Measure (warm, n=5) | Middle | Long | Long minus Middle |
| --- | ---: | ---: | ---: |
| Run p50 | 350.9 ms | 354.1 ms | paired p50 +3.2 ms |
| Run p95 (nearest-rank) | 357.6 ms | 361.3 ms | paired p95 +11.4 ms |
| Profile resolution p50 | 0.098 ms | 0.094 ms | — |
| Action policy total p50 per iteration | 0.0059 ms | 0.0060 ms | — |
| Simulated approver callback total p50 per iteration | 0.0058 ms | 0.0060 ms | — |
| Browser observe total p50 per iteration | 3.86 ms | 3.97 ms | — |
| Browser execute total p50 per iteration | 110.5 ms | 110.8 ms | — |
| Journal append-write total p50 per iteration | 1.77 ms | 1.73 ms | — |
| Journal fsync total p50 per iteration | 76.8 ms | 77.8 ms | — |
| Checkpoint file fsync total p50 per iteration | 38.7 ms | 41.5 ms | — |
| Checkpoint directory fsync total p50 per iteration | 39.8 ms | 39.8 ms | — |
| Journal fsyncs per iteration (exact) | 22 | 22 | 0 |
| Checkpoint file and directory fsyncs per iteration (exact) | 11 each | 11 each | 0 |
| Poll-sampled peak RSS (all iterations, includes cold) | 517,521,408 B | 519,110,656 B | coarse, 100 ms sampling |

The five warm paired run deltas range from -11.0 to +11.4 ms (p50 +3.2 ms); there is no meaningful profile cost difference visible at this sample size. Journal and checkpoint write counts match exactly. RSS is a coarse all-iterations sample, not a warm-only peak or a memory ceiling. Across the separate 100-action synthetic recovery probes, the saved duration profile reloaded unchanged (`middle`/`long`), clean checkpoint replay returned `recovered`, and an open action returned `execution_uncertain` for both. Replay took 11.81 ms (Middle) and 9.59 ms (Long); one probe per profile is not a stable latency comparison. Each recovery probe emitted 112 journal fsyncs and 10 checkpoint file plus 10 directory fsyncs. This measures TaskStore recovery only, not TaskHost/browser/planner reattachment. `approve_call_inclusive` encloses controller work and is not approval latency; stage timings overlap and are not additive components of run time.

Output is one `RESULT_JSON:<json>` line (`schemaVersion: 1`); exit code is nonzero if any iteration diverges from the shared scenario (fail closed). The report-shape smoke test runs under plain `npm test` with a fake browser: `test/routine-vs-planner-benchmark.test.js`.

## Report fields

- `design`: pairs, seed, approval mode, per-pair mode order. The first pair is labelled `cold`, the rest `warm`.
- `summary.{routine,planner}.{cold,warm}`: p50/p95 of run time, cleanup, planner startup (planner only, reported separately), first proposal call, per-proposal round trip, action/proposal/approval/policy counts, and per-stage totals for deterministic profile resolution, policy decision, approver decision, the inclusive `controller.approve()` call, proposal, browser observe/execute, journal preparation/write/fsync, and checkpoint write/fsync/rename/directory-fsync. Each iteration records the selected duration/capability pair.
- `comparison.pairedRunMsDelta`: planner minus routine run time within each pair.
- `memory`: poll-sampled RSS (Electron processes plus registered planner workers) every 100 ms, split by mode.
- `fixture`: per-page request counts, which must be uniform across iterations.

## Limits

- Not a model-quality comparison: the planner is a deterministic scripted worker.
- RSS is poll-sampled and is not a hard memory ceiling.
- The historical one-shot 100-page numbers are a different, non-equivalent comparison.
- Approval is an in-process stand-in for the Python approver; neither mode goes through `TaskHost`, so host memory admission is not exercised.
- `profile_resolution` times one pure local `resolveTaskProfile()` call before TaskStore creation. It performs no model/network request and is not a measure of TaskHost admission or end-to-end user intent classification.
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

## Stage attribution after per-step checkpoint removal (2026-09-29)

Fresh run on the current checkpoint behavior:
`HALO_BENCH_STEPS=50 HALO_BENCH_PAIRS=6 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=review node_modules/.bin/electron integration/routine-vs-planner-benchmark.js`.
All 12 iterations succeeded; the fixture served 50 pages uniformly. Environment:
Electron 44.4.5 / Node 24.21.0 / macOS arm64. The first pair is cold; the five
warm pairs are summarized below. Times are milliseconds, p50 of five per-mode
warm iterations unless specified.

| Stage | Routine | Scripted planner | Routine minus planner |
| --- | ---: | ---: | ---: |
| Run | 1,060.5 | 1,162.2 | -101.7 |
| Action policy decision | 0.021 | 0.023 | -0.002 |
| In-process approver callback | 0.030 | 0.033 | -0.003 |
| `approve_call_inclusive` (not approval latency) | 1,052.673 | 1,064.022 | -11.349 |
| Browser observe | 17.801 | 19.321 | -1.520 |
| Browser execute (includes nested work) | 309.513 | 289.736 | +19.777 |
| Journal preparation | 1.138 | 1.057 | +0.081 |
| Journal append write | 9.890 | 8.911 | +0.979 |
| Journal fsync | 343.808 | 352.941 | -9.133 |
| Checkpoint file write | 3.672 | 3.535 | +0.137 |
| Checkpoint file fsync | 175.619 | 189.496 | -13.877 |
| Checkpoint directory fsync | 192.430 | 171.105 | +21.324 |

The paired `planner - routine` run-time delta was +76.5 ms p50 (six pairs),
so planner was slower in this run, unlike the earlier pre-removal measurement.
Both modes performed exactly 101 journal fsyncs per iteration.
The checkpoint file+directory fsync p50s sum to 368.0 ms for Routine and
360.6 ms for planner, only about 7.4 ms apart. Journal fsync was also close
(Routine about 9.1 ms faster). Thus the earlier ~365 ms gap does not persist
after dropping the per-step checkpoint; current durable-write cost does not
explain the remaining run-time difference. The scripted planner has a separate
first-call startup cost, while policy and the simulated approver callback are
negligible. Stage values are overlapping spans, not additive slices: browser
execution and `approve_call_inclusive` enclose storage and subsequent task
work, so do not sum them into run time. `approve_call_inclusive` is not
approval latency. This is still a deterministic local fixture, not a model
quality or general routine-vs-agent claim; repeat at larger pair counts before
using small differences to tune durability.

## Profile-router overhead (2026-09-29)

Each benchmark iteration now resolves its host-owned duration/capability profile exactly once before `TaskStore.create()`, and reports the elapsed local resolver call as `stages.profile_resolution`. The resolved `(duration, capability)` pair is included with the iteration record. The resolver is deterministic and does not contact a model or network service.

Smoke command: `HALO_BENCH_STEPS=2 HALO_BENCH_PAIRS=2 HALO_BENCH_SEED=29 HALO_BENCH_APPROVAL=allow node_modules/.bin/electron integration/routine-vs-planner-benchmark.js`. All four actual Electron iterations succeeded with matching outcomes and expected routes: Routine=`short/routine`, planner=`middle/browser`. One cold planner profile-resolution sample was 4.71 ms; the other three warm samples were 0.070–0.128 ms. This four-iteration smoke is only a wiring and order-of-magnitude check, not a stable latency estimate. The same output separately reported browser observation/execution, journal append/fsync, and checkpoint write/fsync/rename/directory-fsync stages; those spans overlap and must not be summed as additive wall time.

## Middle vs Long duration profiles (2026-09-29)

Fresh actual-Electron paired run:
`HALO_BENCH_KIND=duration-profile HALO_BENCH_STEPS=50 HALO_BENCH_PAIRS=6 HALO_BENCH_RECOVERY_ACTIONS=300 HALO_BENCH_CHECKPOINT_EVERY=25 ./node_modules/.bin/electron integration/routine-vs-planner-benchmark.js`.
All 12 iterations succeeded on Electron 44.4.5 / Node 24.21.0 / macOS arm64;
the 50-page fixture served each page uniformly. Each duration group has six
samples (one cold and five warm). Values below are per-iteration milliseconds,
reported as p50 across those six samples; these are diagnostic overlapping
spans, not additive components of `runMs`.

| Stage | Middle | Long |
| --- | ---: | ---: |
| Run | 1,171.1 | 1,169.6 |
| Profile resolution | 0.112 | 0.112 |
| Action policy decision | 0.024 | 0.025 |
| In-process approver callback | 0.033 | 0.031 |
| Browser observe | 19.76 | 19.30 |
| Browser execute | 293.21 | 288.09 |
| Journal preparation | 1.25 | 1.18 |
| Journal append write | 9.68 | 9.71 |
| Journal fsync | 359.58 | 357.37 |
| Checkpoint file fsync | 192.02 | 189.24 |
| Checkpoint directory fsync | 189.10 | 180.00 |

The run p50 difference is only -1.5 ms (Long minus Middle), far below the
per-run spread (Middle 1,144.8–1,185.4 ms; Long 1,131.9–1,221.6 ms). This
does **not** demonstrate a Long-profile benefit: in this workload both profiles
performed the same 50 actions, 51 proposal calls, 50 policy checks and 50
review decisions. Current `harness-profile.js` only gives Short a wider safe
batch; Middle and Long share the same batch cap and execution behavior. This
run therefore exposes an implementation gap against the intended duration
profile matrix, rather than evidence that Middle and Long are interchangeable.

The separate 300-action TaskStore recovery probes retained their selected
profile and recovered the open-action case as `execution_uncertain` for both
profiles. Each wrote 602 journal events, issued 314 journal fsyncs and 12
checkpoints. Journal replay took 11.06 ms (Middle) and 9.96 ms (Long), one
probe per profile; these measurements do not cover TaskHost, browser or planner
reattachment. Profile-specific Long continuation/reconstruction behavior is
still unimplemented and needs its own design, implementation and crash-recovery
validation before claiming the duration axis is complete.
