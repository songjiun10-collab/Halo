# Chromium desktop migration implementation ledger

User request: move Electron functionality to local Chromium; implement without launching the product UI, committing, or pushing.

Runtime implementation uses the existing host/controller, with Node running the privileged host and full Chromium rendering the packaged UI. Agent and user pages run in the local Chromium CDP engine. The Electron entry point remains an explicit fallback.

Implemented:

- `desktop-runtime` selects the platform through trusted launch configuration.
- `start-chromium.js` runs the existing host with no Electron resolution, including the background service invocation used by the LaunchAgent.
- Chromium desktop adapter owns windows, window bounds, page views, native macOS dialogs, clipboard, process-tree RSS, and teardown.
- Per-window loopback renderer bridge: host validation, capability + HttpOnly cookie authentication, exact Origin, bounded request bodies/inflight calls, same-origin resources, CSP, bounded event subscribers/backpressure. Existing IPC registry and public APIs are reused.
- Keychain-backed AES-256-GCM storage with legacy Electron macOS `v10` decryption. The v10 derivation was checked against the local Chromium `components/os_crypt/async/browser/keychain_key_provider.mm`; actual user secrets were not read.
- Browser context cookie adapters for import/removal, without clearing unrelated cookies. Session/agent partition ownership is preserved.
- Full Chromium UI profile retains extensions; agent launch continues to disable extensions and uses fresh private profiles.
- Direct tab frame/input, task takeover frame/input, composition/paste text, viewport sizing, navigation events, and async CDP image encoding.
- Frame polling is single-flight and drops stale results on selection/control change.

Verification:

- Initial bridge/storage/session tests: 3 passed.
- Unicode input regression was observed failing, then passed after shared input validation/dispatch implementation.
- Focused host/controller/IPC/surface regression: 200 passed.
- Frontend build passed; frontend tests: 131 passed (existing Vite HMR port and Node localstorage warnings).
- Node imports the Chromium runtime with an Electron import trap: passed.
- Desktop launch extension regression was observed failing, then passed.
- Desktop/browser launch tests: 12 passed.
- Full browser package suite, final fresh run with test concurrency 2: 1876 passed, 0 failed, 0 skipped (330.393 seconds).
- Final focused runtime/lifecycle/settings/desktop checks: 43 passed. Typecheck and generated-runtime consistency checks passed.
- The initial full run found stale lifecycle mocks, settings expectations and compiler cohort expectations; these were updated to match the current explicit runtime contract, then the whole suite was rerun.

Remaining checks:

- Review and integration coverage of teardown/navigation/frame races remains necessary; passing existing tests does not establish total Electron parity.
- The real product UI and real Keychain migration have not been exercised; the request specified implementation only.
- Chrome extension installation itself is not automated or claimed.
- Current CDP persistent agent contexts retain state for the engine lifetime; cross-browser-restart IndexedDB/localStorage persistence requires further native-profile support. No parity claim is made for that boundary.
- Desktop `setWindowOpenHandler` and shell navigation prevention are not yet equivalent to Electron; the bridge rejects remote privileged requests, but native window restrictions need implementation.
- Session `clearStorageData` currently clears cookies only. Other website storage deletion needs explicit CDP support.
- Engine reconfiguration now pins existing pages/sessions to their creation generation; retired browser connections close after their final page closes. See `2026-10-07-harness-connection-generation-progress.md` for fresh verification. Native Dock lifecycle and full multi-window app-mode parity are not verified.
