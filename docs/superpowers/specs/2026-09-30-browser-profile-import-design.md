# HALO Browser Profile Import Design

Status: Chrome cookie import (phase 1) and Chrome bookmarks/search engines/homepage/startup pages (phase 2) are merged to `main` (PRs #14–#16, current implementation through 2026-09-30). Active opted-in task partitions are cleared on removal or allowlist narrowing; if Electron leaves a matching cookie behind, the affected parent and child plan are stopped and their browser views are disposed, while the host still reports revocation failure. The macOS/Ubuntu Python and Rust CI checks passed, and the full Electron app suite passed 994 tests at the merged implementation. Safari, autofill, localStorage and the production renderer UI are not in `main`. Sub-project A of 2. Sub-project B (passing this Claude Code conversation's context into Halo browser tasks) is deferred and gets its own spec. Not verified: a real Keychain prompt, a fresh real Chrome-profile import, and a signed-in load of claude.ai/chatgpt.com. The host/preload API includes `window.halo.importSessions / listImportedSessions / removeImportedSession / getSessionAllowlist / setSessionAllowlist`, and a task opts in with `createTask(goal, { useImportedSessions: true })`.

## Goal

Let a Halo browser task start already signed in to claude.ai and chatgpt.com by importing those sites' sessions from the user's existing Chrome (and Safari, best effort), and let the user carry over a small set of other browser settings. Task sessions stay isolated: nothing is shared between tasks, and nothing is written back to Chrome or Safari.

## Confirmed decisions

- Source browsers: Chrome and Safari.
- Cookie scope: an allowlist of registrable domains, initially `claude.ai` and `chatgpt.com` (plus `openai.com`, `anthropic.com` only if login needs them; decided by test). The user can edit the list later in settings.
- Storage: an encrypted `SessionVault` modeled on `LocalCredentialVault` (Electron `safeStorage`, file `sessions.enc` under the app data directory).
- Use: injected per task into that task's own non-persistent partition `halo-task-${taskId}` before the first navigation.
- Settings to import: autofill data, per-site localStorage/IndexedDB, bookmarks, search engines, homepage/startup page. Extensions are excluded.

## Design

### Components

1. `ChromeProfileReader` (`main/harness/profile-import/chrome-reader.js`): locate profiles under `~/Library/Application Support/Google/Chrome`, read `Cookies` (SQLite via built-in `node:sqlite`, on a temp copy because Chrome locks the file), decrypt values with the "Chrome Safe Storage" key from the macOS Keychain (PBKDF2-SHA1, salt `saltysalt`, 1003 iterations, AES-128-CBC, `v10` prefix; newer Chrome prefixes the plaintext with a SHA-256 of the host key, which must be stripped). Also reads `Bookmarks` (JSON), `Preferences` (homepage, startup URLs), `Web Data` (`keywords` table for search engines, `autofill` tables).
2. `SafariProfileReader`: `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies` and `~/Library/Safari/Bookmarks.plist`. Both are TCC-protected and need Full Disk Access for the Halo app. If access is denied the reader returns `{ status: "permission_required" }` and the UI tells the user what to enable. Never prompt-bypass.
3. `SessionVault` (`main/harness/session-vault.js`): stores only allowlisted cookies as `{ domain, name, value, path, secure, httpOnly, sameSite, expires }` plus `{ source, importedAt }`. Encrypted at rest with `safeStorage`; refuses to write in plaintext if `safeStorage.isEncryptionAvailable()` is false. Values never appear in logs, IPC replies to the renderer, journals or task events; the renderer sees only `{ domain, name count, importedAt, source, expiresAt }`.
4. `SessionInjector`: on task start, for a task that has opted in, calls `session.cookies.set` on the task's partition for each vault cookie whose domain is in the current allowlist and not expired, then reports the count. Injection is a copy: task-side changes (refreshed tokens) are discarded at task end unless the user re-imports.
5. `SettingsImporter`: writes bookmarks, search engines and homepage into a Halo profile-settings file (not into Chrome). Autofill and site storage are handled as described below.
6. IPC (`main/ipc.js`, `preload/index.js`): `halo:importProfile({ browser, kinds })`, `halo:listImportedSessions`, `halo:removeImportedSession({ domain })`, `halo:setSessionAllowlist({ domains })`. Handlers validate input; renderer never receives cookie values.

### Per-task opt-in

A task uses imported sessions only when its creator sets `useImportedSessions: true` (default false). This keeps a routine, a scheduled run or a prompt-injected page from silently acting as the user on claude.ai/chatgpt.com. The task journal records that sessions were injected and for which domains, never the values.

### Data kinds and honest limits

| Kind | Approach | Limit |
| --- | --- | --- |
| Cookies (allowlisted) | Chrome SQLite + Keychain key; Safari binarycookies | Chrome needs a Keychain approval prompt for "Chrome Safe Storage"; Safari needs Full Disk Access. Sessions with device binding, short-lived rotating tokens or `__Secure-` / `__Host-` prefix rules may fail to inject or be revoked by the site. Cloudflare or bot checks on these sites may still challenge an Electron browser; that is not bypassed. |
| Bookmarks, search engines, homepage | Chrome JSON/SQLite; Safari plist | Read-only import; mapped into Halo's own settings. |
| Autofill (names, addresses, phones) | Chrome `Web Data` autofill tables | Passwords and payment cards are excluded by design: they stay in the OS password manager and are never copied. |
| localStorage (per site, allowlist only) | Chrome LevelDB under `Local Storage/leveldb` | LevelDB parsing is fragile; best effort, phase 2. Auth for claude.ai/chatgpt.com mostly lives in cookies, so it is not required for A. |
| IndexedDB | Chrome LevelDB blobs | Not planned for the first release; reported as unsupported rather than half-imported. |
| Extensions | Not imported | Out of scope per the user. |

### Failure behavior

Each reader returns a structured result (`ok`, `permission_required`, `not_found`, `decrypt_failed`, `locked`). Partial success is reported per kind. Nothing is retried in a loop, no permission prompt is bypassed, and a failed import never deletes the existing vault.

### Security notes

- Cookies for these two sites are account credentials. Scope is the allowlist only; a broader "all cookies" import was explicitly not chosen.
- Encrypted vault only; a `remove` action deletes both the record and the in-memory copies.
- Automating a logged-in account can breach the sites' terms or trigger account protections; the UI says so once at first import.
- The planner and page content can never trigger an import or read vault values; import is a user-initiated IPC action only.

## Phasing

1. Chrome cookies for the allowlist + `SessionVault` + `SessionInjector` + per-task opt-in + minimal UI (import, list, remove). Verify by unit tests with fixture SQLite and by a manual signed-in check on claude.ai/chatgpt.com.
2. Bookmarks, search engines, homepage (Chrome), then Safari cookies/bookmarks behind Full Disk Access.
3. Autofill (non-secret fields), then localStorage best effort.

## Testing

Failing tests first for each unit: Chrome cookie decryption against a fixture DB encrypted with a known test key (the Keychain call is injected), allowlist filtering, vault round-trip with an injected fake `safeStorage`, refusal to store when encryption is unavailable, injector calls on a fake session, journal entries contain no values, IPC input validation. Manual verification only for real Keychain/TCC prompts and real sites, reported as such.

## Out of scope

Sub-project B (conversation-context passthrough), extensions, passwords, payment cards, writing back into Chrome or Safari, syncing changes made inside Halo, and any CAPTCHA or bot-detection bypass.

## Phase 1 implementation notes

- Code: `apps/computer-browser/main/harness/profile-import/` (`chrome-cookie-reader.js`, `session-vault.js`, `session-injector.js`, `profile-importer.js`, `domain-utils.js`). `TaskHost` takes `profileImporter` and `getTaskSession`.
- Chrome stores `expires_utc` as microseconds since 1601 (~1.3e16), above `Number.MAX_SAFE_INTEGER`; the reader reads it as BigInt.
- Chrome DB version 24 and later prefixes each decrypted value with SHA-256 of the host key; the reader verifies and strips it, and treats a mismatch as a decrypt failure.
- Opt-in and the allowlist live in plain (non-secret) `session-config.json`; cookie values only in the encrypted `sessions.enc`.
- Injection runs before the task's browser is built, only for opted-in tasks; a failure never blocks the task. The journal gets one `imported_sessions_injected` note with counts and domains, never values.
- Sessions injected into a task partition are a copy and are discarded with it; refreshed tokens are not written back.

## Phase 2 (Chrome) implementation notes

- `chrome-settings-reader.js` reads `Bookmarks` (JSON; http(s) only, 5000 max, folder path kept), `Preferences` (homepage, and startup pages only when Chrome is set to open specific pages) and `Web Data` `keywords` (https engines with `{searchTerms}` only, on a temp copy). Everything is read-only and non-secret.
- Results are stored in `session-config.json` as `importedSettings` and exposed through `importBrowserSettings` / `getImportedSettings` (host, IPC, preload, background service). Nothing is applied to Halo's UI yet; the data is imported and readable.
- Checked against the real Chrome profile on the development machine with counts only: status ok, 2 bookmarks, 7 search engines, no custom homepage.
- A failed re-import keeps the previously stored settings.
