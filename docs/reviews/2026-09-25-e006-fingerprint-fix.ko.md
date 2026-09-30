# halo/gateway.py — 어댑터 지문의 로드 모드 불안정성 수정 — 2026-09-25

`experiments/e006_fault_injection/README.ko.md`의 "발견 2"(marshal 기반
어댑터 지문이 로드 모드에 따라 달라지는 문제, 높음 심각도, report-only —
실험은 gateway.py를 고치지 않는다고 명시)를 실제로 수정했다.

## 근본 원인

`halo/gateway.py`의 `_code_fingerprint`는 어댑터 함수의 코드 객체 전체를
그대로 marshal해 해시했다:

```python
@staticmethod
def _code_fingerprint(func):
    code = getattr(func, "__code__", None)
    if code is None:
        raise Rejected("non-function adapters require an explicit fingerprint")
    defaults = _encode([func.__defaults__, func.__kwdefaults__])
    return hashlib.sha256(marshal.dumps(code) + defaults).hexdigest()
```

`marshal.dumps(code)`는 **동일 소스에서 나온 동일 co_filename의 코드
객체라도, 그 코드 객체가 (a) 해당 프로세스에서 방금 컴파일된 것인지, 아니면
(b) `.pyc` 캐시를 다른 프로세스에서 언마샬해 재구성한 것인지에 따라 다른
바이트를 낸다.** marshal은 반복되는 상수를 객체-동일성 기반 백레퍼런스로
중복 제거하는데, 두 프로세스에서 문자열/객체 인터닝 상태가 다르면 구조적으로
동일한 코드 객체라도 이 백레퍼런스 패턴이 달라진다.

실제 영향: capability를 승인한 프로세스와 그것을 나중에 실행하는 프로세스가
같은 어댑터를 서로 다른 로드 모드로 읽어들이면(예: 하나는 방금 컴파일, 다른
하나는 `.pyc` 캐시에서 로드), 지문이 달라져 **유효한 capability가 거짓
거부**된다. `_adapter_fingerprint`가 이 지문을 승인 시점에 발급된 토큰의
digest 검증에 그대로 사용하므로, worker 재시작처럼 프로세스가 바뀌는
시나리오에서 언제든 발화할 수 있는 잠재적 가용성 결함이다.

## 재현

`marshal.dumps(func.__code__)` 직접 해시가 fresh-import와 cached-import
사이에서 실제로 달라지는지 서브프로세스 기반으로 확인했다(같은 파일을 같은
인터프리터로 두 번 import — 첫 실행이 `.pyc`를 쓰고 두 번째 실행이 그
캐시를 읽는다):

```
exec-string     : ba423d5d...
import (fresh)  : 78463bb3...
import (cached) : 374e175a...   # fresh와 다름
as __main__ file: 374e175a...
```

4가지 로드 모드 중 `import (fresh)`만 다른 값을 낸다 — 정확히 README가
가리키는 축이다.

## 수정

`marshal.dumps(code)`를 코드 객체 그대로 넘기는 대신, 반복되는 상수의
백레퍼런스 문제를 만들 수 없는 **평탄하고 결정적인 필드 튜플**로 먼저
분해한 뒤 그 튜플을 marshal한다:

```python
def _canonical_code(code):
    consts = tuple(_canonical_code(c) if type(c) is CodeType else c for c in code.co_consts)
    return (code.co_argcount, code.co_posonlyargcount, code.co_kwonlyargcount,
            code.co_nlocals, code.co_flags, code.co_code, consts,
            code.co_names, code.co_varnames, code.co_freevars, code.co_cellvars)
```

```python
return hashlib.sha256(marshal.dumps(_canonical_code(code)) + defaults).hexdigest()
```

- 중첩 코드 객체(클로저/컴프리헨션)는 재귀적으로 같은 방식으로 분해한다.
- `co_code`(원본 바이트코드), `co_consts`/`co_names`/`co_varnames`/
  `co_freevars`/`co_cellvars`(평범한 튜플)만 남기고, marshal이 튜플 자체를
  덤프할 때는 그 튜플 안에 중첩 코드 객체가 남아있지 않으므로(이미
  `_canonical_code`로 치환됨) 백레퍼런스發 불안정성이 들어올 자리가 없다.
- `co_filename`/`co_firstlineno`/`co_name`/`co_qualname` 등 위치·이름
  메타데이터는 원래도 지문에 넣을 의도가 아니었고(정상적인 리팩터링에도
  바뀔 수 있음) 계속 제외된다 — 다만 이번 수정으로 `co_filename`이 스크립트
  실행 시 상대경로가 되는 문제(README의 부모/워커 co_filename 불일치)도
  부수적으로 사라진다.
- 소스 텍스트 해시(예: `inspect.getsource` 기반)로 바꾸는 방안은 채택하지
  않았다 — 기존 테스트(`test_fingerprint_distinguishes_constants_and_defaults`)가
  요구하는 "상수/기본값 변경 시 지문도 바뀐다"는 변조 탐지 속성을 소스 텍스트
  해시는 공백/포매팅 변경에도 깨지거나, 반대로 의미 있는 바이트코드 차이를
  놓칠 수 있어 코드 객체 기반 분해보다 약하다.

## 검증

```
.venv/bin/python -m pytest -q
# 402 passed (기존 401 + 신규 1)

.venv/bin/python -m pytest tests/test_gateway_adversarial.py -q -k fingerprint
# 3 passed

.venv/bin/python experiments/e006_fault_injection/run_fault_injection.py
# report-only findings: 0 (수정 전과 동일 — 이 실험의 표준 실행 경로는
# import 기반이라 애초에 이 finding을 발화시키지 않는다, 아래 범위 참고)
```

신규 회귀 테스트
(`tests/test_gateway_adversarial.py::test_code_fingerprint_stable_across_pyc_cache_and_fresh_compile`):
임시 모듈 파일을 만들고 같은 `python -c` 스크립트로 두 번 import한다(첫
실행이 `.pyc`를 쓰고, 두 번째 실행이 그 캐시를 읽는 것을 `__pycache__`
존재로 확인) — 두 지문이 같아야 한다.

이 테스트를 작성하며 한 가지 함정을 발견해 고쳤다: 처음 작성한 버전은
중첩 클로저(`factory()`가 리스트 컴프리헨션을 쓰는 `inner`를 반환)를
썼는데, **구버전(수정 전) 코드에 대해 되돌려 실행해도 통과했다** — 즉 가짜
회귀 테스트였다. Python 3.12부터 리스트 컴프리헨션이 별도 코드 객체로
분리되지 않고 인라인되므로(PEP 709), 그 특정 구조는 marshal 불안정성을
유발하는 상수 백레퍼런스 패턴을 우연히 건드리지 않았던 것이다. 위 "재현"
절의 단순한 평면 함수(중첩 없음, `for` 루프 + 누산)로 바꾸자 구버전 코드에
대해서는 실제로 실패(`fresh != cached`)하고, 수정된 코드에 대해서는
통과하는 것을 `git stash`로 직접 확인했다.

## 범위와 한계

- `experiments/e006_fault_injection/README.ko.md`의 2026-09-23 표와 발견
  2는 그날 원자료로 보존, 아래에 후속 절만 추가한다.
- 실험의 `worker_restart_after_effect_subprocess` 시나리오는 부모/워커가
  **같은 `_tool_spec` 팩토리를 import로 공유**하도록 설계되어 있어(주석에
  명시: "same code objects -> same adapter fingerprint"), 표준 실행 경로
  (`.venv/bin/python experiments/e006_fault_injection/run_fault_injection.py`,
  즉 import 기반)에서는 이 finding이 수정 전에도 발화하지 않았다 — README도
  이를 "실험 진입점에서는 발화하지 않는다"고 명시한다. 따라서 실험을
  재실행해 finding 개수 감소를 보이는 것으로는 이 수정을 검증할 수 없고,
  위처럼 별도 서브프로세스 기반 재현과 전용 pytest 회귀 테스트로 검증했다.
- 어댑터의 클로저/전역/설정이 바뀌었는데 코드 바이트 자체는 그대로인
  경우(예: 참조하는 전역 변수의 값만 바뀜)는 여전히 지문에 반영되지 않는다
  — 이는 기존에도 명시된 한계("hosts must bump revision/fingerprint for
  closure/global/config changes")이며 이번 수정의 범위가 아니다.
- 발견 1(mono clock 오류 처리)은 이미 수정됨
  ([2026-09-25-e006-mono-clock-fix.ko.md](2026-09-25-e006-mono-clock-fix.ko.md)) —
  이번 수정과 무관.

- [halo/gateway.py](../../halo/gateway.py)
- [tests/test_gateway_adversarial.py](../../tests/test_gateway_adversarial.py)
