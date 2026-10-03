import assert from 'node:assert/strict'
import test from 'node:test'
import { syncDirectSurface, syncNativeSurface } from '../src/session/browser-surface.ts'

test('native browser viewport follows the rendered page bounds and hides when a panel covers it', async () => {
  const calls = []
  const api = { setTaskViewport: async (...args) => calls.push(args) }
  const element = { getBoundingClientRect: () => ({ left: 12, top: 94, width: 800, height: 500 }) }

  await syncNativeSurface(api, 'task-1', element, true)
  await syncNativeSurface(api, 'task-1', element, false)

  assert.deepEqual(calls, [
    ['task-1', { x: 12, y: 94, width: 800, height: 500, visible: true }],
    [null, { x: 0, y: 94, width: 0, height: 0, visible: false }],
  ])
})

test('native browser surface stays hidden until a task and real page element exist', async () => {
  const calls = []
  const api = { setTaskViewport: async (...args) => calls.push(args) }
  const element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }

  await syncNativeSurface(api, null, element, true)
  await syncNativeSurface(api, 'task-1', null, true)
  await syncNativeSurface(api, 'task-1', element, true)

  assert.equal(calls.length, 3)
  assert.ok(calls.every(([taskId, viewport]) => taskId === null && viewport.visible === false))
})

test('user-owned browser bounds are clamped by main and hidden when a task takes ownership', async () => {
  const calls = []
  const api = { setBrowserBounds: async (bounds) => calls.push(bounds) }
  const element = { getBoundingClientRect: () => ({ left: 12, top: 94, width: 800, height: 500 }) }
  await syncDirectSurface(api, element, true)
  await syncDirectSurface(api, null, false)
  assert.deepEqual(calls, [
    { x: 12, y: 94, width: 800, height: 500, visible: true },
    { x: 0, y: 94, width: 0, height: 0, visible: false },
  ])
})

test('a page snapshot is taken only as a JPEG data URL and never throws', async () => {
  const { captureSnapshot } = await import('../src/session/browser-surface.ts')
  const jpeg = 'data:image/jpeg;base64,AAAA'
  assert.equal(await captureSnapshot({ captureSurface: async () => jpeg }), jpeg)
  assert.equal(await captureSnapshot({ captureSurface: async () => null }), null)
  assert.equal(await captureSnapshot({ captureSurface: async () => 'https://evil.example/x.png' }), null, 'only an inline image from main')
  assert.equal(await captureSnapshot({ captureSurface: async () => { throw new Error('gone') } }), null)
  assert.equal(await captureSnapshot({}), null, 'an older preload without the method')
})
