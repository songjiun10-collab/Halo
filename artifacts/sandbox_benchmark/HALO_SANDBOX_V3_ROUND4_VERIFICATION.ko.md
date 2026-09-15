# HALO macOS 샌드박스 Round-4 브레이크아웃 검증 보고서 (2026-09-13)

> 과거 Round-4 고정 기록이다. 최신 100개 사례·20회 반복·보안 게이트 판정은 [REPORT_INDEX.ko.md](../../REPORT_INDEX.ko.md)와 [최신 JSON](../../rust/results/attack-100-validated-20.json)을 우선한다.

> Round-1/2/3·madness가 다루지 않은 **새 커널 평면**을 HARDENED 프로파일 안에서 직접 공격했다.
> 합성 카나리·루프백만 사용하며 호스트 쓰기는 없다. 실행: `run_round4.py --repeats N`.

## 요약

12개 새 벡터 × HARDENED(clean env, closed FD, RLIMIT_NPROC=1)에서 **6/12 탈출**. libproc 프로세스 열거, UDP, 확장 sysctl 스캔, xattr은 차단으로 확인. `access(2)` 파일-존재 오라클과 전체 마운트 테이블 노출이 이번 라운드의 가장 강한 유출이다.

| 벡터 | 평면 | HARDENED 결과 |
| --- | --- | --- |
| `access_oracle` | access(2)/F_OK 존재 오라클 | 🚨 탈출 3/3 |
| `getfsstat_full` | 전체 마운트 테이블 | 🚨 탈출 3/3 |
| `launchdaemons_read` | `/System/Library` 서브패스 재사용 | 🚨 탈출 3/3 |
| `usr_share_read` | `/usr/share` 콘텐츠 | 🚨 탈출 3/3 |
| `host_processor_info` | Mach 프로세서 토폴로지 | 🚨 탈출 3/3 |
| `getattrlist_vol` | 볼륨 속성 | 🚨 탈출 3/3 |
| `proc_listpids` | libproc `proc_info(2)` | ✅ 차단 3/3 |
| `proc_pidpath` | libproc 경로 해석 | ✅ 차단 3/3 |
| `proc_pidinfo_parent` | 부모 태스크 정보 | ✅ 차단 3/3 |
| `sysctl_deep_scan` | hw.*/machdep.cpu.*/vm.* | ✅ 차단 3/3 |
| `udp_network` | UDP 소켓 평면 | ✅ 차단 3/3 |
| `xattr_scan` | listxattr/getxattr | ✅ 차단 3/3 |

---

## 1. 🚨 `access(2)` 호스트 전체 파일-존재 오라클

HARDENED 프로파일은 `file-read-metadata`를 워크 디렉터리·로더 경로로만 허용하지만,
`access(2)`/`faccessat(F_OK)`는 이 스코핑을 **전혀 거치지 않는다**. 실격리 경로 밖의 카나리와
실제 유저 홈 파일 존재가 그대로 노출된다.

```python
os.access("/Users/<user>/.zsh_history", os.F_OK)      # -> True  (샌드박스 내부에서 확인됨)
os.access("/Users/<user>/.gitconfig", os.F_OK)        # -> True
os.access("/Users/<user>/Library/Keychains/login.keychain-db", os.F_OK)  # -> True
os.access("/Users/<user>/Documents", os.F_OK)         # -> True
```

- **유출 내용:** 호스트 전체 파일·디렉터리 존재 여부 (설정·히스토리·키체인·문서 경로 정찰). 존재하지 않는 경로(`~/.ssh/id_rsa`, `/etc/passwd`, `/etc/sudoers`)는 정확히 `False`를 돌려줘 오라클로 동작한다.
- **의미:** sandbox-exec에 `access` 룰 클래스가 없다 → 호스트 파일 존재 스캔이 단일 syscall로 가능. 읽기 내용은 아니지만 실홈 영역에 대한 존재성 침해다.

## 2. 🚨 `getfsstat` 전체 마운트 테이블

`statfs` 단건 노출을 넘어 `getfsstat(MNT_NOWAIT)`가 **호스트의 모든 볼륨·장치를 한 번에** 반환한다.

```
/                        <- /dev/disk3s1s1   [apfs]
/System/Volumes/Data     <- /dev/disk3s5     [apfs]
/Volumes/OpenCode 1.18.25-arm64  <- /dev/disk4s1  [hfs]
/Volumes/ChatGPT Installer      <- /dev/disk5s1  [hfs]
... (총 13개 마운트, 장치 노드 포함)
```

- **유출 내용:** 마운트된 외장 볼륨 이름(`/Volumes/*`), APFS 볼륨 스키마, 장치 노드 매핑. 호스트 디스크 레이아웃 전체.
- `getattrlist(2)` 역시 루트 볼륨 속성(rc=0)을 반환하며 `file-read-metadata` 스코핑을 우회한다.

## 3. 🚨 `/System/Library` 서브패스 그랜트 재사용

dyld 로더 예외인 `(subpath "/System/Library")` 콘텐츠 읽기가 실제 호스트 시스템 구성까지 노출한다.

- `/System/Library/LaunchDaemons` — **432개** 데몬 plist 읽음 (XML 콘텐츠)
- `/System/Library/LaunchAgents` — **483개** 에이전트 plist 읽음
- `/System/Library/Extensions` — **700개** kext 번들
- `/usr/share/man`, `/usr/share/locale` — 디렉터리 열거

**유출 내용:** 전체 시스템 런치 데몬/에이전트 설정 (실행 경로, 환경변수, 권한 설정), kext 목록. `system_version_read`(빌드 번호)보다 훨씬 풍부한 호스트 구성 정보.

## 4. 🚨 Mach `host_processor_info`

Mach 호스트 포트에서 프로세서 기본 정보 조회. 샌드박스가 중재하지 않는 Mach 평면.

```
processor_count = 10   (실제 호스트 CPU 수)
```

- `mach_host_statistics`(Round-3)와 같은 평면을 프로세서 토폴로지로 확장한 유출.

## 차단 확인 (긍정적 결과)

- **libproc 차단:** `proc_listpids`/`proc_pidpath`/`proc_pidinfo` 모두 `EPERM`. `deny process-info*`가 sysctl 뿐 아니라 `proc_info(2)` 게이트까지 실제로 커버한다. (검증 전 유력 후보였음)
- **UDP 차단:** 루프백/외부 UDP bind·connect 모두 거부. TCP에 이어 네트워크 평면 전체가 닫혀 있음.
- **sysctl 이름 허용목록 유지:** hw.logicalcpu/physicalcpu, machdep.cpu.brand_string, vm.swapusage, kern.bootargs 등 25개 심층 스캔 전부 `EPERM`. 허용 5개(hw.machine, kern.hostname, kern.ostype, kern.osrelease, kern.version)만 열림.
- **xattr 차단:** listxattr/getxattr 전 경로 `EPERM`.

## 미해결 노출 요약

1. **파일-존재 오라클** — `access(2)`가 `file-read-metadata` 스코핑을 우회, 실홈·키체인·히스토리 경로 존재 정찰 가능
2. **마운트 테이블** — `getfsstat`으로 호스트 전체 볼륨·장치·외장 볼륨명 열거
3. **시스템 구성** — `/System/Library/LaunchDaemons`·`LaunchAgents`·`Extensions` plist/kext 콘텐츠
4. **Mach 프로세서 토폴로지** — `host_processor_info`

## 결론

- 임의 코드 실행·파일 내용 유출(실홈)·네트워크 송신·프로세스 목록은 해당 Round-4 실행의 HARDENED 프로파일에서 **차단 상태**였다.
- 그러나 `access(2)`, `getfsstat`, `getattrlist`는 샌드박스가 중재하지 않는 **신규 syscall 평면**으로, `file-read-metadata` 스코핑과 `deny process-info*`가 모두 우회된다. macOS `sandbox-exec`는 이 계열 syscall에 대한 룰 클래스가 없어 단일 프로파일로는 차단 불가능.
- 호스트 정보 비노출을 요구하는 실행은 별도 게스트(VM/컨테이너) 재검증이 필요하며, "완전 격리"는 현재 호스트에서 주장하지 않는다 (RECHECK.ko.md와 동일 한계 유지).
