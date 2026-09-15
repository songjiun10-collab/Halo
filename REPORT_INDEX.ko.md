# HALO 보고서 기준점

현재 상태 기준은 2026-09-14이다. 과거 보고서는 당시 원자료로 보존하며 최신 보안 상태를 나타내는 근거로 사용하지 않는다.

- Python 전체: 159개 통과
- Rust 통계 워크스페이스: 57개 통과
- Rust 샌드박스 실행기: 14개 통과

추가 수정 검증: `exec_cat_absolute`가 작업 디렉터리의 심볼릭 링크를 실행하던 오류를 `/bin/cat` 절대 경로 실행으로 수정했다. 링크 없는 회귀 테스트를 추가했고, 수정 후 100개 공격과 정상 3개를 3모드에서 1회 실행한 309건은 오류 0이었다. [수정 후 원자료](rust/results/attack-100-exec-fix.json)의 clean-launch 결과는 91개 차단·9개 성공이다. 아래 20회 반복 수치는 수정 전 고정 실행 기록이다.
- 103개 사례(공격 100개 + 정상 3개) × 20회 × 3모드: 6,180회 실행
- clean-launch: 정상 60/60, 공격 1,820/2,000 차단, 180/2,000 성공
- inherited-capabilities: 정상 60/60, 공격 1,740/2,000 차단, 260/2,000 성공
- unconfined-control: 정상 60/60, 공격 0/2,000 차단, 2,000/2,000 성공
- 잔여 성공(각 20회): `metadata_access_parent`, `metadata_chdir`, `metadata_fstatat_root`, `metadata_getcwd`, `metadata_getpid`, `metadata_lstat_root`, `metadata_pathconf`, `metadata_statfs`, `metadata_statvfs`
- 실행 오류 0, 임시 fixture 정리 확인
- 보안 게이트: 실패(잔여 메타데이터 접근)

[최신 원자료](rust/results/attack-100-validated-20.json)

`REPORT.ko.md`, `RUST_RUNNER.ko.md`, `DYNAMIC_VERIFICATION_2026-09-13.ko.md`, `RECHECK.ko.md` 및 루트 익스플로잇 보고서는 이전 실행의 고정 수치다. 최신 수치와 상충하면 이 파일과 최신 JSON을 우선한다. “완전 차단”, “0% 실패”, “완전 격리”는 제한된 당시 범위 주장으로만 읽는다.

현재 `chdir`·`statvfs`는 최소 C 프로그램에서도 `(version 1)(deny default)` 후 성공했다. 100개 사례 확장 결과 clean-launch에서 9개 메타데이터 사례가 남았다. macOS Seatbelt만으로 해결됐다고 기록하지 않는다. Wasmtime capability 실행 또는 공유 디렉터리·네트워크를 제거한 Linux VM을 다음 격리 경계 후보로 본다.
