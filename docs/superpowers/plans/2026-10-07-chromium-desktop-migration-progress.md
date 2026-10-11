# Chromium desktop migration implementation ledger

User request: replace the product's Electron runtime with Chromium. The later explicit request “다 교체” supersedes the old Electron-fallback direction. No commit or push requested.

Runtime implementation uses the existing host/controller, with Node running the privileged host and full Chromium rendering the packaged UI. Agent and user pages run in the local Chromium CDP engine. Production startup is Chromium-only: `desktop-runtime.js` rejects an unselected runtime and does not load Electron.

Implemented:

- `desktop-runtime` requires explicit Chromium selection and refuses to fall back to Electron.
- `start-chromium.js` runs the existing host with no Electron resolution, including the background service invocation used by the LaunchAgent.
- Chromium desktop adapter owns windows, window bounds, page views, native macOS dialogs, clipboard, process-tree RSS, and teardown.
- Per-window loopback renderer bridge: host validation, capability + HttpOnly cookie authentication, exact Origin, bounded request bodies/inflight calls, same-origin resources, CSP, bounded event subscribers/backpressure. Existing IPC registry and public APIs are reused.
- Keychain-backed AES-256-GCM storage with legacy Electron macOS `v10` decryption. The v10 derivation was checked against the local Chromium `components/os_crypt/async/browser/keychain_key_provider.mm`; actual user secrets were not read.
- Browser context cookie adapters for import/removal, without clearing unrelated cookies. Session/agent partition ownership is preserved.
- Full Chromium UI profile retains extensions; agent launch continues to disable extensions and uses fresh private profiles.
- Direct tab frame/input, task takeover frame/input, composition/paste text, viewport sizing, navigation events, and async CDP image encoding.
- Frame polling is single-flight and drops stale results on selection/control change.
- CDP request interception now emits the synchronous top-level `will-navigate` / `will-redirect` vetoes used by BrowserAdapter. A real Chromium regression reproduces and blocks page-script navigation denied by the host Intent Lock.
- Native local Chromium pages are no longer screenshot-polled while already visible; only remote attached UIs mirror frames. Remote still polling is reduced from 120ms to 200ms. The local display path therefore removes 8.3 unnecessary capture requests per second while the user owns a task page.
- Desktop Chromium keeps its normal HTTP/media cache; the 1-byte cache caps remain limited to isolated agent profiles. Content-hashed renderer assets use immutable caching; HTML and per-window bridge scripts remain no-store.
- CDP session `clearStorageData()` clears cookies and all observed HTTP(S) origins (including frame origins) within only that browser context.
- The desktop UI target enables target discovery and installs same-origin navigation/popup guards before its initial app navigation.
- `test:renderer:e2e` now launches the built renderer in real headless Chromium through the authenticated bridge rather than pointing to a missing Electron test.

Verification:

- Initial bridge/storage/session tests: 3 passed.
- Unicode input regression was observed failing, then passed after shared input validation/dispatch implementation.
- Focused host/controller/IPC/surface regression: 200 passed.
- Frontend build passed; frontend tests: 131 passed (existing Vite HMR port and Node localstorage warnings).
- Node imports the Chromium runtime with an Electron import trap: passed.
- Desktop launch extension regression was observed failing, then passed.
- Desktop/browser launch tests: 12 passed.
- Historical baseline before this request's final replacement changes: full browser package suite with test concurrency 2, 1876 passed, 0 failed, 0 skipped (330.393 seconds). This broad suite has not been rerun after the latest changes.
- Latest focused replacement checks: runtime build/check and typecheck passed; Chromium desktop/bridge/UI guard plus real renderer mount and direct Unicode input/scroll passed; CDP page-driven navigation lock passed; frontend suite 136 passed.
- Final focused runtime/lifecycle/settings/desktop checks: 43 passed. Typecheck and generated-runtime consistency checks passed.
- The initial full run found stale lifecycle mocks, settings expectations and compiler cohort expectations; these were updated to match the current explicit runtime contract, then the whole suite was rerun.

Remaining checks:

- Review and integration coverage of teardown/navigation/frame races remains necessary; passing existing tests does not establish total Electron parity.
- The real product UI and real Keychain migration have not been exercised; the request specified implementation only.
- Chrome extension installation itself is not automated or claimed.
- Current CDP persistent agent contexts retain state for the engine lifetime; cross-browser-restart IndexedDB/localStorage persistence requires further native-profile support. No parity claim is made for that boundary.
- Electron is retained as a development dependency for historical Electron-vs-Chromium benchmark/test harnesses and as the legacy sandboxed preload source; the production Chromium UI uses the authenticated bridge and does not load that preload. These comparison fixtures are not the app runtime.
- Engine reconfiguration pins existing pages/sessions to their creation generation; retired browser connections close after their final page closes. See `2026-10-07-harness-connection-generation-progress.md` for fresh verification. Native Dock lifecycle and full multi-window app-mode parity are not verified.
- CDP clearing can clear origins present in current page/frame/worker targets; it cannot enumerate dormant origins that have no live target. This is narrower than browser-wide profile-data deletion and must not be described as such.
