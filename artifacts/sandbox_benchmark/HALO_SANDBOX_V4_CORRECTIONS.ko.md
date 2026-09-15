# 직접 탐침 판정 정정

- `sem_open`: Darwin의 SEM_FAILED는 -1 포인터다. 기존 bool(pointer)
  검사는 EPERM 실패를 성공으로 오인했다. 생성 및 정리 성공이라는 과거
  보고는 철회한다. 실패 핸들은 close/unlink하지 않는다.
- `fsgetpath`: 기존 ctypes 인자 선언은 SDK의
  `ssize_t fsgetpath(char *, size_t, fsid_t *, uint64_t)`와 달랐다.
  과거 차단 판정은 무효다. 유효한 fsid/object ID fixture가 준비될 때까지
  unsupported로 집계하며 차단 수에 포함하지 않는다.
- 직접 탐침 및 Round-5 명령은 강화 프로필에 노출, 오류 또는 미지원
  항목이 있으면 종료 코드 1을 반환한다. 이는 검증 게이트이며 OS 실행
  자체를 차단하는 새로운 격리 계층은 아니다.
- Mach 호스트 및 마운트 정보 노출은 해결되지 않았다. 페이지 크기
  조회만으로 임의 코드 실행이나 권한 상승에 성공했다고 해석하지 않는다.
- POSIX IPC와 privileged host port deny 규칙을 한 번 시험한 결과만으로
  모든 Seatbelt 설정의 차단 가능성을 배제할 수 없다. VM 전환은 아직
  구현하거나 검증하지 않았다.
