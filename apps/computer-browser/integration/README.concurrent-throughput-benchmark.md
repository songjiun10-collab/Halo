# Concurrent throughput benchmark

Submits N saved-routine runs at once to a real `TaskHost` (real `BrowserAdapter` with Electron `WebContentsView`s, real `TaskStore`, real `MemoryMonitor`) against the local fixture from `routine-vs-planner-benchmark.js`, for N = 1..4, and reports tasks per minute, queue wait, per-task RSS increment and admission outcomes. It answers one question from `docs/superpowers/specs/2026-09-29-parallel-task-throughput-design.md`: is throughput bound by the slot cap (`maxParallelTasks`) or by memory admission?

## Run

From `apps/computer-browser`:

```bash
HALO_BENCH_LEVELS=1,2,3,4 HALO_BENCH_REPEATS=6 HALO_BENCH_STEPS=50 HALO_BENCH_SEED=29 node_modules/.bin/electron integration/concurrent-throughput-benchmark.js
```

| Env | Default | Meaning |
| --- | --- | --- |
| `HALO_BENCH_LEVELS` | `1,2,3,4` | concurrency levels (each also sets `maxParallelTasks`) |
| `HALO_BENCH_REPEATS` | 6 (min 2) | iterations per level; repeat 0 is the cold one, order across levels is seeded-random per repeat |
| `HALO_BENCH_STEPS` | 50 | routine steps per task |
| `HALO_BENCH_SEED` | 1 | schedule seed |
| `HALO_BENCH_SETTLE_MS` | 500 | pause between iterations (0..10000 ms) |
| `HALO_BENCH_RESERVE_MODE` | `production` | `production` uses TaskHost's real reserve rules; `diagnostic` passes `parallelTaskReserveBytes` so admission cannot bind |
| `HALO_BENCH_DIAGNOSTIC_RESERVE_BYTES` | 50,000,000 | reserve per task in diagnostic mode |

Output is one `RESULT_JSON:<json>` line (`kind: "concurrent-throughput-benchmark"`, `schemaVersion: 1`). The report-shape smoke test runs under plain `npm test` with a fake browser.

Run it only as the entry script (`electron integration/concurrent-throughput-benchmark.js`). The direct-invocation guard compares `process.argv[1]` with `__filename`; `require.main === module` is always false under Electron's main process, and the earlier `process.versions.electron ||` guard made `routine-vs-planner-benchmark.js` execute itself and call `app.exit()` when it was merely required.

## Measurement (2026-09-30)

Electron 44.4.5 / Node 24.21.0 / macOS arm64, 50 routine steps per task, seed 29, 6 repeats per level (1 cold + 5 warm). Latency and RSS are machine dependent; warm statistics use 5 observations, so nearest-rank p95 is the maximum. These are small-sample diagnostics, not a performance claim.

### Production admission (real reserve rules)

All 24 iterations succeeded, no admission denials were recorded.

| N | tasks/min (warm p50) | wall p50 | peak concurrent browsers | admitted immediately | waited for slot | per-task RSS increment p50 | peak RSS p50 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 76.7 | 783 ms | 1 | 5 | 0 | 145 MB | 526 MB |
| 2 | 78.4 | 1532 ms | 1 | 5 | 5 | 73 MB | 519 MB |
| 3 | 80.7 | 2231 ms | 1 | 5 | 10 | 50 MB | 526 MB |
| 4 | 82.6 | 2906 ms | 1 | 5 | 15 | 37 MB | 528 MB |

Throughput is flat at about 77-83 tasks/min whatever the slot cap. The host never runs more than one browser at a time: with the 1,000,000,000-byte `MemoryMonitor` cap, a ~340 MB Electron baseline and a 370 MB per-task reserve, a second lease is refused, so every extra task queues behind the first. Memory admission, not the slot count, is the ceiling. The apparent drop in per-task RSS increment with N is only the fixed peak divided by a larger N.

### Diagnostic mode (50 MB reserve, admission cannot bind; not a production configuration)

| N | tasks/min (warm p50) | wall p50 | peak concurrent browsers | per-task RSS increment p50 / p95 | peak RSS p50 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 76.4 | 785 ms | 1 | 145.0 / 150.6 MB | 483 MB |
| 2 | 122.6 | 979 ms | 2 | 149.8 / 154.3 MB | 633 MB |
| 3 | 139.7 | 1289 ms | 3 | 145.4 / 152.6 MB | 774 MB |
| 4 | — | — | — | — | — |

With admission out of the way, throughput scales (76 -> 123 -> 140 tasks/min) and the incremental RSS per browser is stable at about 145-154 MB, well under the 370 MB reserve.

Failures (7 of 24 iterations, all `iteration timed out after 180000 ms`): the cold N=3 iteration and every N=4 iteration (6 of 6). N=1 and N=2 completed in all repeats, warm N=3 completed in all five. The failures are CPU or resource contention on this machine (predicted peak at N=4 is about 920 MB, close to the hard cap, and iterations stall rather than finish), not a memory-admission denial and not a benchmark bug: no denial was recorded, and the guard fix was verified separately.

## Decision on `ROUTINE_TASK_RESERVE_BYTES`

Not adopted; the 370 MB reserve is unchanged.

The spec allows a lower routine-only reserve if the diagnostic mode shows an incremental RSS well below 370 MB. It does (p95 up to 154.3 MB). It is not enough on its own, because:

- The same run shows the machine cannot sustain the concurrency a lower reserve would allow: a reserve of about 200 MB would admit three browsers (about 340 + 3 x 200 MB), and N=3 timed out on its cold start, N=4 in every repeat.
- Three concurrent browsers peak near 774 MB against the 1 GB hard cap, and RSS is poll-sampled every 100 ms, so a transient spike can be missed.
- The baseline includes residue from earlier iterations, so the per-task increment is an estimate.
- Nothing measured here covers routines that touch heavy real sites, where the per-tab cost is larger than the local fixture's.

Reducing the reserve would trade a measured safety margin for a throughput gain that failed to complete reliably on the only machine tested. Revisit with real-site routines, a second machine, and a stall investigation for cold N=3 before changing admission.

## Limits

- Routine-only workload against a local fixture; other sites and other CPUs will differ.
- Approval is an in-process allow stand-in; each task ends in `awaiting_verification` and is stopped to release its slot, so slot release is not a human-paced wait. Scheduled runs that wait for humans hold slots longer.
- Single machine, single run per mode, five warm samples per level.
