import assert from 'node:assert/strict'
import test from 'node:test'
import { BackgroundRuntimeStore, MEMORY_OVERRIDE_WARNING } from '../src/session/background-runtime.ts'

function harness(overrides = {}) {
  let listener
  const calls = []
  const api = {
    getBackgroundRuntimeSnapshot: async () => ({ connection: 'connected', service: 'running', memoryPolicy: 'budgeted' }),
    attachBackgroundRuntime: async () => { calls.push('attach'); return { connection: 'connected', service: 'running', memoryPolicy: 'budgeted' } },
    detachBackgroundRuntime: async () => { calls.push('detach') },
    setMemoryPolicy: async (mode) => { calls.push(['policy', mode]); return { connection: 'connected', service: 'running', memoryPolicy: mode } },
    stopBackgroundService: async () => { calls.push('stop'); return { connection: 'connected', service: 'stopped', memoryPolicy: 'budgeted' } },
    onBackgroundRuntimeEvent: (cb) => { listener = cb; return () => { listener = undefined } },
    ...overrides,
  }
  return { api, calls, emit: (snapshot) => listener?.(snapshot) }
}

test('memory override requires a separate explicit confirmation and states the actual risk', async () => {
  const { api, calls } = harness()
  const store = new BackgroundRuntimeStore(api)
  assert.match(MEMORY_OVERRIDE_WARNING, /automatic memory-pressure pauses/i)
  assert.match(MEMORY_OVERRIDE_WARNING, /OS memory pressure/i)
  assert.equal(await store.setMemoryPolicy('user_override'), false)
  assert.deepEqual(calls, [])
  assert.equal(await store.setMemoryPolicy('user_override', true), true)
  assert.deepEqual(calls, [['policy', 'user_override']])
  assert.equal(store.getState().memoryPolicy, 'user_override')
})

test('reconnect attaches at most once and never resubmits a task', async () => {
  const { api, calls } = harness()
  const store = new BackgroundRuntimeStore(api)
  const unsubscribe = store.connect()
  await store.connectRuntime()
  await store.connectRuntime()
  assert.deepEqual(calls, ['attach'])
  assert.equal(store.getState().connection, 'connected')
  unsubscribe()
  assert.deepEqual(calls, ['attach'])
})

test('detach is separate from explicit task/service stop', async () => {
  const { api, calls } = harness()
  const store = new BackgroundRuntimeStore(api)
  await store.detach()
  assert.deepEqual(calls, ['detach'])
  await store.stopService()
  assert.deepEqual(calls, ['detach', 'stop'])
  assert.equal(store.getState().service, 'stopped')
})

test('runtime push updates connection, service, and memory mode without secret fields', () => {
  const { api, emit } = harness()
  const store = new BackgroundRuntimeStore(api)
  store.connect()
  emit({ connection: 'connected', service: 'running', memoryPolicy: 'budgeted', capability: 'must-not-appear' })
  assert.deepEqual(store.getState(), { connection: 'connected', service: 'running', memoryPolicy: 'budgeted', error: null })
})

test('malformed runtime state fails closed instead of exposing an unknown state', () => {
  const { api, emit } = harness()
  const store = new BackgroundRuntimeStore(api)
  store.connect()
  emit({ connection: 'connected', service: 'waiting_for_approval', memoryPolicy: 'budgeted' })
  assert.equal(store.getState().connection, 'unavailable')
  assert.equal(store.getState().service, 'unavailable')
  assert.match(store.getState().error, /invalid background runtime snapshot/i)
})

test('start at login goes through the host and keeps the reported install state', async () => {
  const { api, calls } = harness({
    setBackgroundLaunchAtLogin: async (enabled) => { calls.push(['login', enabled]); return { connection: 'disconnected', service: 'stopped', memoryPolicy: 'budgeted', launchAgentInstalled: enabled } },
  })
  const store = new BackgroundRuntimeStore(api)
  assert.equal(await store.setLaunchAtLogin('yes'), false)
  assert.equal(await store.setLaunchAtLogin(true), true)
  assert.deepEqual(calls, [['login', true]])
  assert.equal(store.getState().launchAgentInstalled, true)
  const failing = new BackgroundRuntimeStore({ setBackgroundLaunchAtLogin: async () => { throw new Error('launchctl bootstrap failed') } })
  assert.equal(await failing.setLaunchAtLogin(true), false)
  assert.match(failing.getState().error, /launchctl/)
  assert.equal(await new BackgroundRuntimeStore({}).setLaunchAtLogin(true), false)
})
