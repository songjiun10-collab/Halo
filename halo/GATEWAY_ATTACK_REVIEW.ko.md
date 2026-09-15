# 권한 게이트웨이 직접 결함 재현 및 수정

범위: 로컬 임시 SQLite DB, WSGI 요청, 메모리 효과를 갖는 신뢰된 테스트
도구. 외부 배포·메일 발송·파일 변경 도구는 연결하지 않았다.

수정 전 네 테스트가 각각 실패했고 수정 후 통과했다.

| 경계 | 재현된 결함 | 수정 |
|---|---|---|
| 인증 이전 | 틀린 Bearer 키로도 본문 스트림 read 호출 | 역할 인증을 본문 읽기 이전 수행 |
| 권한 이전 | 위조 토큰으로 도구 validate 호출 | 토큰/인자/만료 사전 검사 후 검증기 호출, claim 때 재검사 |
| 실행 후 실패 | 효과 발생 후 예외가 HTTP 403 거부로 표시 | ExecutionUncertain 및 HTTP 503, 재시도 전 효과 대조 명시 |
| 취소 | 이미 claimed인 실행도 revoked=true 반환 | UPDATE 실제 변경 여부 반환, 감사에 revoke_not_applied 구분 |

추가 검증: 검증기가 실행 중일 때 다른 요청이 취소하면 dispatch하지 않는다.
SQLite trigger로 claimed 감사 삽입을 실패시키면 효과가 발생하지 않는다.
completed 감사 삽입을 실패시키면 이미 발생한 효과가 존재하며, claimed가
유지되어 새 Gateway 인스턴스의 재요청도 중복 효과를 만들지 않는다.

명령: `.venv/bin/python -m pytest tests/test_gateway_adversarial.py -q`

한계: TLS/proxy의 slow-client 방어, 사용자별 인증, 신뢰된 어댑터 내부의
TOCTOU, OS 샌드박스 탈출, 관리자 DB 변조, 호스트 전원 장애는 검증하지
않았다. 잘못된 인증의 조기 거부가 인증된 요청의 느린 업로드까지 막지는
않는다. 검증기와 실제 도구는 신뢰된 코드여야 하며 별도 시간·자원 제한이
필요하다. 재현된 네 결함 중 임의 도구의 무권한 실행은 확인되지 않았다.
