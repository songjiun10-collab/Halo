# 음성 입력 (Whisper, 이 컴퓨터 안에서)

채팅 입력칸 옆의 마이크 버튼을 누르면 녹음, 다시 누르면 글자로 바뀌어 입력칸에 들어간다. **자동으로 보내지 않는다.** 읽어 보고 직접 보낸다.

## 프라이버시
- 소리는 이 컴퓨터를 떠나지 않는다. 앱 안에서 whisper.cpp(`whisper-cli`)를 직접 실행해 글자로 바꾼다. 외부 서버나 플래너로 가는 것은 변환된 **글자**뿐이고, 그 글자는 직접 타이핑한 글과 똑같은 규칙(카드·주민번호 가리기, 개인정보 티어)을 받는다.
- 소리 파일은 임시 폴더(권한 0700)에 잠깐 쓰고 변환이 끝나면(실패해도) 지운다. 저널·로그에 소리는 남지 않는다.
- 한 번에 최대 120초, 한 번에 한 클립. 형식이 다르면(16kHz 모노 16비트 WAV가 아니면) 프로그램에 닿기 전에 거부한다.
- **카드번호·비밀번호·인증번호는 말로 하지 않는다.** 말한 내용도 글자가 되면 일반 채팅 글과 같다. 채팅으로 보낸 카드번호는 작업 시작 시점에 저널에 이미 남는 알려진 한계가 있으므로(`docs/superpowers/specs/2026-10-13-payment-mandate-design.md`), 그런 정보는 직접 페이지에 입력한다.

## 설치 (앱에 들어 있지 않다)
앱 데이터 폴더의 `voice/` 에 두 가지를 넣는다. (macOS: `~/Library/Application Support/halo-computer-browser/voice/`)
1. `whisper-cli` — [whisper.cpp](https://github.com/ggml-org/whisper.cpp)를 빌드한 실행 파일.
2. `ggml-base.bin` (또는 다른 `ggml-*.bin`) — whisper.cpp가 안내하는 모델 받기 스크립트로 받는다. 한국어는 `base`로 시작해 보고, 부족하면 `small` 이상.

다른 위치를 쓰려면 환경변수 `HALO_WHISPER_BIN`, `HALO_WHISPER_MODEL`. 둘 중 하나라도 없으면 마이크 버튼이 보이지 않는다.

## 아직 확인하지 못한 것
- 실제 마이크와 실제 whisper.cpp로 돌려 본 적이 없다(테스트는 가짜 프로그램으로 한다). 첫 실제 실행에서 whisper-cli 옵션(`-nt -np -l`)이 설치한 버전에서 맞는지 확인할 것.
- macOS는 마이크 권한 문구(`NSMicrophoneUsageDescription`)가 패키징에 들어가야 한다. `tools/package-mac.sh`에는 아직 없다.
- 소리 길이 제한은 있지만 말을 끝까지 듣는 자동 종료(말이 멈추면 끊기)는 없다. 버튼을 다시 눌러 끝낸다.
