#!/usr/bin/env python3
"""E006 runner: fault-injection experiment on the gateway lifecycle.

실행: `.venv/bin/python experiments/e006_fault_injection/run_fault_injection.py`
결과에 escaped/error/uncaught가 있으면 성공 게이트가 아니다.

이 러너는 실험 모듈을 **import해서** 실행한다. 스크립트로 직접 실행하면
co_filename이 달라져 어댑터 지문이 바뀌고(marshal이 co_filename을 포함한다),
워커 subprocess와 부모의 지문이 일치하지 않게 된다.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from experiments.e006_fault_injection.experiment import run


def main() -> int:
    summary, _ = run()
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    invariants = summary["invariants"]
    findings = summary["findings"]
    inv1 = invariants["INV1_claim_once"]["verdict"]
    inv2 = invariants["INV2_no_wrong_rejection"]["verdict"]
    print()
    print(f"INV1 claim-once: {inv1}"
          f" | B2 residuals: {invariants['INV1_claim_once']['b2_residuals']}")
    print(f"INV2 no-wrong-rejection: {inv2}")
    print(f"report-only findings: {len(findings)}")
    for item in findings:
        print(f"  [{item['severity']}] {item['scenario']}: {item['finding'][:100]}")
    # INV 위반은 실패다. report-only 발견은 실패가 아니라 기록이다.
    violated = (inv1 != "held") or (inv2 != "held")
    return 1 if violated else 0


if __name__ == "__main__":
    raise SystemExit(main())
