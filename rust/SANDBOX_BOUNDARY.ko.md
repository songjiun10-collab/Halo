# Rust 샌드박스 런타임 읽기 제한

> 현재 샌드박스 실행 결과와 보안 게이트의 기준점은 [REPORT_INDEX.ko.md](../REPORT_INDEX.ko.md)와 [최신 JSON](results/attack-100-validated-20.json)이다. 아래는 경계 원인 분리와 설계 한계를 기록한다.

추가 원인 분리: `artifacts/sandbox_benchmark/seatbelt_boundary.c`는 런타임 시작 후 `(version 1)(deny default)`만 적용하고 `chdir`와 `statvfs`를 호출한다. 현재 호스트에서 sandbox 초기화 성공 후에도 두 호출이 모두 0(성공)을 반환했다. 따라서 이 두 접근을 기존 루트 허용만의 결과로 단정할 수 없고, 현재 Seatbelt 정책의 허용 목록을 줄이는 것만으로 차단했다고 주장할 수 없다. 관찰 결과는 `rust/results/seatbelt-deny-default.json`에 보존한다. 이 진단은 C API 동작을 Rust 실행기와 독립적으로 확인하기 위한 것으로 제품 경로에 연결되지 않는다.

대안 검토 결과, Wasmtime의 WASI는 명시적으로 연결된 import와 pre-open 디렉터리만 제공하는 capability 모델이므로 네이티브 호스트 호출 자체를 노출하지 않는 계산 작업에 적합하다. 네이티브 코드가 필요하면 Apple Virtualization Framework로 공유 디렉터리와 네트워크 장치를 구성에서 제외한 Linux VM을 사용하고, VM 내부에서 seccomp를 보조 경계로 적용한다. Linux Landlock만으로는 `chdir` 같은 호출 제한이 불가능하므로 단독 대안으로 채택하지 않는다. 이 저장소에는 아직 Wasm 런타임이나 VM 실행기가 연결돼 있지 않다.

실행 보고서에는 `security_gate.passed` 및 `residual_cases`를 추가했다. 검사 테스트 자체의 통과를 보안 게이트 통과로 혼동하지 않도록 미차단 경로를 명시한다. 이 목표를 만족하려면 호스트 파일시스템을 노출하지 않는 별도 VM 같은 다른 격리 경계를 구현하고 검증해야 하며, 현재 저장소에 그러한 실행 경계는 구현되지 않았다.

Rust 벤치 실행기의 macOS sandbox-exec 프로필에서 `/System/Library` 내용 및 메타데이터 허용을 제거했다. `runtime_content_read`와 `runtime_metadata_read`는 이 경계를 검사한다. 파일 내용은 보고서에 저장하지 않는다. 파일 부재나 실행 오류는 차단 성공으로 계산하지 않는다. 현재 clean-launch에서 남은 성공은 `metadata_chdir`와 `metadata_statvfs` 두 사례이며, 이 결과는 `REPORT_INDEX.ko.md`와 최신 JSON을 우선한다.

실행 명령:

```sh
artifacts/sandbox_benchmark/rust_runner/target/release/halo-sandbox-runner --repeats 20 --output rust/results/attack-100-validated-20.json
```

초기 10개 공격 유형 검증은 과거 결과다. 최신 검사는 하드링크 생성 후 읽기, rename을 통한 외부 파일 교체, 임시 UNIX 소켓 연결, 허용된 실행 파일의 재실행을 통한 외부 파일 읽기, 시스템 파일 메타데이터 조회를 포함해 100개 공격 유형으로 확대했다. 소켓과 쓰기 대상은 임시 테스트 자원이다.

초기 확대 검사에서 `runtime_metadata_read`가 성공했으나, 프로필의 `/System/Library` 허용을 제거한 후 재검증에서 차단됐다. 최신 100개 결과는 `rust/results/attack-100-validated-20.json`이다.

100개 검사로 확대한 현재 게이트는 통과하지 않는다. clean-launch에서 `metadata_access_parent`, `metadata_chdir`, `metadata_fstatat_root`, `metadata_getcwd`, `metadata_getpid`, `metadata_lstat_root`, `metadata_pathconf`, `metadata_statfs`, `metadata_statvfs`가 성공한다. 파일 내용 읽기 성공과는 다르지만, 금지된 호스트 자원 접근이라는 검사 목표에는 실패다. 루트 읽기 허용을 제거하거나 메타데이터만 허용하는 실험은 정상 실행 자체가 실패해 채택하지 않았다. 이 사실만으로 각 접근의 정확한 커널 원인까지 확정한 것은 아니다.

검사 구현은 매 시도마다 삭제 가능한 fixture를 복구하고, 상속된 파일의 읽기 위치를 초기화한다. EPERM/EACCES 및 지정한 FD 검사에서의 EBADF만 차단으로 계산한다. ENOENT/EEXIST나 빈 읽기 결과는 검사 오류다. 내용 읽기는 실제 canary와 일치해야 성공이다. 100개는 서로 다른 API와 경로 변형을 포함한 검사 사례 수이며 100개의 독립 취약점 범주를 의미하지 않는다. 통합 테스트는 100개 사례의 집계와 잔여 메타데이터 접근, 보안 게이트 종료 코드 1이 정확히 보고되는지 확인한다.

이 변경은 Rust 벤치 실행기에 적용된다. Python 실행기, 제품 실행기, VM 격리의 구현이나 검증을 뜻하지 않는다. `/usr/lib` 읽기, 시스템 메타데이터 조회 등 런타임 예외는 남아 있으며, 이 테스트가 모든 macOS 자원 접근을 다루는 것도 아니다. 같은 커널을 공유하는 sandbox-exec는 독립 VM과 동일한 보안 경계가 아니다. 악성 요청에 대조군 모드를 노출해서는 안 된다.
