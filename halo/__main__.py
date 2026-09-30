"""`python -m halo` — doctor/verify 단일 진입점.

checkout 밖에서도 동작한다 (state를 만지지 않는다). 서브커맨드 없으면
doctor를 기본 실행한다.
"""

import sys

from halo.doctor import main

if __name__ == "__main__":
    sys.exit(main())
