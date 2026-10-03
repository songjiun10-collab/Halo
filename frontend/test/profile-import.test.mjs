import assert from 'node:assert/strict'
import test from 'node:test'
import { ProfileImportStore } from '../src/session/profile-import.ts'

function harness(overrides = {}) {
  const calls = []
  const api = {
    listImportedSessions: async () => [{ domain: 'claude.ai', cookieCount: 3, source: 'chrome', importedAt: '2026-09-30T00:00:00.000Z', value: 'must-not-appear' }],
    getSessionAllowlist: async () => ['claude.ai', 'chatgpt.com'],
    setSessionAllowlist: async (domains) => { calls.push(['allowlist', domains]); return domains },
    importSessions: async (input) => { calls.push(['import', input]); return { status: 'ok', imported: 3, browser: 'chrome' } },
    removeImportedSession: async (domain) => { calls.push(['remove', domain]); return true },
    importBrowserSettings: async (input) => { calls.push(['settings', input]); return { status: 'ok', browser: 'chrome', bookmarks: 2, searchEngines: 7, startupUrls: 0, homepage: false } },
    getImportedSettings: async () => ({ browser: 'chrome', importedAt: '2026-09-30T00:00:00.000Z', bookmarks: [{}, {}], searchEngines: [{}], homepage: null, startupUrls: [] }),
    ...overrides,
  }
  return { api, calls }
}

test('refresh loads sessions, allowlist and settings summary and drops unknown fields', async () => {
  const { api } = harness()
  const store = new ProfileImportStore(api)
  assert.equal(await store.refresh(), true)
  const s = store.getState()
  assert.deepEqual(s.sessions, [{ domain: 'claude.ai', cookieCount: 3, source: 'chrome', importedAt: '2026-09-30T00:00:00.000Z' }])
  assert.deepEqual(s.allowlist, ['claude.ai', 'chatgpt.com'])
  assert.deepEqual(s.settings, { browser: 'chrome', importedAt: '2026-09-30T00:00:00.000Z', bookmarks: 2, searchEngines: 1, hasHomepage: false, startupUrls: 0 })
  assert.equal(JSON.stringify(s).includes('must-not-appear'), false)
})

test('a missing API leaves the store unavailable instead of throwing', async () => {
  const store = new ProfileImportStore(undefined)
  assert.equal(store.getState().available, false)
  assert.equal(await store.refresh(), false)
  assert.equal(await store.importFromChrome(), false)
})

test('importing from Chrome reports a human message per status and refreshes afterwards', async () => {
  const { api, calls } = harness()
  const store = new ProfileImportStore(api)
  assert.equal(await store.importFromChrome(), true)
  assert.deepEqual(calls[0], ['import', { browser: 'chrome', profile: 'Default' }])
  assert.match(store.getState().message, /3 cookies/)
  assert.equal(store.getState().busy, false)
  for (const [status, pattern] of [['permission_required', /keychain|permission/i], ['not_found', /not find/i], ['decrypt_failed', /decrypt/i], ['locked', /locked|try again/i], ['unsupported', /not supported/i]]) {
    const h = harness({ importSessions: async () => ({ status, imported: 0, browser: 'chrome' }) })
    const s = new ProfileImportStore(h.api)
    assert.equal(await s.importFromChrome(), false)
    assert.match(s.getState().message, pattern, status)
  }
})

test('unknown or malformed replies fail closed', async () => {
  const bad = harness({ importSessions: async () => ({ status: 'exploded', imported: 'x' }) })
  const store = new ProfileImportStore(bad.api)
  assert.equal(await store.importFromChrome(), false)
  assert.match(store.getState().error, /unexpected reply/i)
  const badList = harness({ listImportedSessions: async () => [{ domain: 5 }] })
  const s2 = new ProfileImportStore(badList.api)
  assert.equal(await s2.refresh(), false)
  assert.match(s2.getState().error, /unexpected reply/i)
})

test('only one command runs at a time', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { api, calls } = harness({ importSessions: async (input) => { calls.push(['import', input]); await gate; return { status: 'ok', imported: 1, browser: 'chrome' } } })
  const store = new ProfileImportStore(api)
  const first = store.importFromChrome()
  assert.equal(store.getState().busy, true)
  assert.equal(await store.importFromChrome(), false)
  release()
  await first
  assert.equal(calls.filter(([k]) => k === 'import').length, 1)
})

test('allowlist edits are normalised, validated and de-duplicated before they reach the host', async () => {
  const { api, calls } = harness()
  const store = new ProfileImportStore(api)
  await store.refresh()
  assert.equal(await store.addDomain('  Example.ORG '), true)
  assert.deepEqual(calls.at(-1), ['allowlist', ['claude.ai', 'chatgpt.com', 'example.org']])
  const before = calls.length
  assert.equal(await store.addDomain('claude.ai'), false)
  assert.equal(await store.addDomain('localhost'), false)
  assert.equal(await store.addDomain('https://evil.example/path'), false)
  assert.equal(await store.addDomain(''), false)
  assert.equal(calls.length, before)
  assert.match(store.getState().error, /valid domain/i)
  assert.equal(await store.removeDomain('chatgpt.com'), true)
  assert.deepEqual(calls.at(-1), ['allowlist', ['claude.ai']])
})

test('removing a session and importing settings call the host and refresh', async () => {
  const { api, calls } = harness()
  const store = new ProfileImportStore(api)
  assert.equal(await store.removeSession('claude.ai'), true)
  assert.deepEqual(calls[0], ['remove', 'claude.ai'])
  assert.equal(await store.importSettings(), true)
  assert.deepEqual(calls[1], ['settings', { browser: 'chrome', profile: 'Default' }])
  assert.match(store.getState().message, /2 bookmarks.*7 search engines/)
})

test('host errors surface as an error message and clear busy', async () => {
  const { api } = harness({ removeImportedSession: async () => { throw new Error('vault unavailable') } })
  const store = new ProfileImportStore(api)
  assert.equal(await store.removeSession('claude.ai'), false)
  assert.equal(store.getState().error, 'vault unavailable')
  assert.equal(store.getState().busy, false)
})

test('canUseSessions is true only when at least one live session exists', async () => {
  const empty = new ProfileImportStore(harness({ listImportedSessions: async () => [] }).api)
  await empty.refresh()
  assert.equal(empty.getState().sessions.length > 0, false)
  const full = new ProfileImportStore(harness().api)
  await full.refresh()
  assert.equal(full.getState().sessions.length > 0, true)
})
