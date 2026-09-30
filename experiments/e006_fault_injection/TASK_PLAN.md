# E006 fault injection — task plan (subagent session)

Baseline: 374 passed / 0 failed (full suite, 2026-09-23).
Files I may touch: experiments/e006_fault_injection/* (keep empty __init__.py),
tests/test_e006_fault_injection.py. Everything else OFF-LIMITS.

## Scenario matrix (16)

fault types → injection points:
1. adapter_exception_before_effect / after_effect (execute raises) → ExecutionUncertain
2. adapter_double_failure (effect + rewind clock + raise → failed_or_uncertain audit also fails)
3. slow_adapter (threading.Event bounded delay, not network timers)
4. concurrent_revoke_validate / _dispatch (threads + Events; revoke lands while blocked)
5. clock_rollback_before_claim / _after_dispatch / _tolerated (ManualClock via constructor params)
6. db_copy_db_only (fork refused — fail-closed) ; db_copy_full_snapshot + db_restore_old_snapshot
   (B2 residual: DB+realm sidecar copy → double spend, documented, expected finding)
7. worker_restart_before_effect / _after_effect (in-process SystemExit crash sim)
   / _subprocess (real os._exit crash, effect via temp-file sink)

## Invariants checked (fail-closed → findings)
- INV1 claim-once: 한 토큰의 효과가 최대 1회 (per-token delta accounting)
- INV2 no-wrong-rejection: post-dispatch failures → ExecutionUncertain, never plain Rejected
  (ExecutionUncertain extends Rejected → exact-type classification required)

## Metrics
effects, unauthorized_effects(무승인), duplicate_effects(중복), uncertain_responses(불확실),
wrong_rejections(잘못된 거부), replay_refused + new_token_execute_succeeds(복구 동작),
benign_success_rate(정상 성공률), benign_success_same_instance(usefulness cost), duration_ms

## Status
- [x] read gateway.py, GATEWAY.ko.md, e001b/e003 conventions, review doc #2
- [ ] experiment.py
- [ ] run_sweep.py
- [ ] tests/test_e006_fault_injection.py
- [ ] README.ko.md (fill numbers after run)
- [ ] verify: pytest e006 file, full suite, runner
