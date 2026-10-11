# Aside와의 비교 절차 (2026-10-11)

## 현재 상태

Halo 쪽 측정은 있고 Aside 쪽 측정은 없다. 따라서 "Aside보다 빠르다/정확하다"는 주장은 아직 할 수 없다.

- Halo: `2026-10-07-online-mind2web-pilot.md`의 5개 과제 파일럿(수동 판정 완료 2/5, 미완료 2/5, 보류 1/5)과 `integration/` 벤치 하네스. 공식 채점이 아니다.
- Aside: 닫힌 제품이라 이 저장소와 세션에서는 실행하거나 계측할 수 없다. 사용자가 직접 같은 과제를 돌려야 한다.
- 구조 차이(권한 구조 lease/effect 분류, 에이전트당 renderer 분리, 사용자 창 비침범)는 설계와 테스트로 확인된 사실이지, 성공률이나 속도의 근거가 아니다.

## 고정 조건

두 제품에 아래를 똑같이 적용한다. 하나라도 다르면 결과를 "비교"로 부르지 않는다.

1. 과제: `osunlp/Online-Mind2Web` 중 읽기 전용 과제. 첫 비교는 파일럿의 5개(데이터 SHA-256 `7dedf381…257f`)에 사이트 차단 영향이 적은 15개를 더해 20개로 한다. 과제 문구를 바꾸지 않는다.
2. 시작 상태: 새 프로필, 로그인 없음, 같은 네트워크, 같은 날 같은 시간대에 연속 실행.
3. 한도: 과제당 180초, 사용자 개입 없음. 캡차·접근 차단은 두 쪽 모두 우회하지 않고 "차단"으로 기록한다.
4. 모델: 가능하면 같은 모델 계열. 다르면 표에 모델을 병기하고 결론에서 모델 효과와 하네스 효과를 분리해서 말하지 않는다.
5. 반복: 과제당 3회. 1회 결과로 결론 내지 않는다.

## 기록 항목

과제별로 다음을 한 줄로 기록한다(`bench-<날짜>-aside-vs-halo.jsonl`).

`task_id, product, model, run, success(수동 증거 판정: done/not_done/unclear), blocked(captcha|access_denied|none), wall_ms, steps, user_interventions, final_url`

채점은 최종 화면과 과제 문구를 대조하는 수동 증거 판정으로 하고, 판정자는 어느 제품의 결과인지 모르는 상태로 섞어서 채점한다. `unclear`는 실패로도 성공으로도 세지 않고 따로 보고한다.

## 보고 방식

- 성공률은 `done / (done + not_done)`과 `unclear` 건수를 함께 쓴다. 분모에서 `blocked`를 빼지 않고 별도 열로 둔다.
- 시간은 중앙값과 최댓값. 평균만 쓰지 않는다.
- 표본이 20개 × 3회이므로 차이가 작으면 "차이 없음"으로 쓴다.
- Halo가 지는 과제도 숨기지 않고 사유(locator 실패, 승인 대기, 사이트 차단 등)를 붙인다.

## Halo 쪽 실행

```bash
cd apps/computer-browser
HALO_PILOT_SCOPE=full node integration/online-mind2web-pilot.ts /path/to/Online_Mind2Web.json
```

실행마다 새 결과 디렉터리가 만들어지며 `run.json`과 `trajectory/`가 증거로 남는다.

## 이 문서가 주장하지 않는 것

Aside의 내부 동작이나 점수는 추정하지 않는다. 이 절차가 끝나기 전에는 비교 우위 문구를 README나 제품 문구에 넣지 않는다.
