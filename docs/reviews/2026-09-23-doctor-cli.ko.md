# 로컬 진단·검증 CLI — 2026-09-23

이전 작업 계획의 미구현 doctor/verify 진입점을 구현했다.
저장소 루트에서 다음 명령을 사용한다.

```sh
.venv/bin/python -m halo doctor
.venv/bin/python -m halo verify --json
```

`doctor`는 현재 Python의 pytest 가용성과 증거 레지스트리를 검사한다.
`verify`는 현재 Python으로 전체 pytest와 증거 검사를 모두 실행한다.
둘 중 하나라도 실패하면 exit 1이다. 각 검사에는 300초 제한이 있으며,
프로세스 실행 실패나 시간 초과도 실패로 보고한다. 증거 해시를 자동 갱신하지 않는다.
`--json`은 검사별 상태·출력과 전체 상태를 단일 JSON 객체로 반환한다.
검사 작업 디렉터리는 호출자의 현재 디렉터리가 아닌 모듈의 저장소 루트다.
저장소 밖에서는 해당 Python이 halo 패키지를 import할 수 있어야 한다.

이번 실행 결과:

- 기존 코드 기준 pytest: 374 통과.
- CLI 회귀 포함 전체 pytest: 383 통과, 10.49초.
- CLI 회귀 9개: 실패 종료 전달, 두 검사 모두 실행, 실행 오류·시간 초과,
  레지스트리 부재, JSON 출력, 저장소 외부에서 모듈 진입 확인.
- 증거 검사: valid 1, stale 2, unsupported 1. `verify` exit 1.
- stale 항목: 과거 260-test 주장 및 2026-09-21 F01–F13 스냅샷 판정.

이 명령의 범위는 Python 회귀와 등록된 증거의 파일 해시 확인이다.
Rust 회귀, OS 격리, 외부 감사·복구, 배포 준비 완료를 보증하지 않는다.
과거 공격 보고서 전체의 재검증이나 Codex Security 스캔 완료도 의미하지 않는다.
