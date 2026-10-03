import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { applyTheme, watchSystemTheme } = await vite.ssrLoadModule('/src/session/theme.ts')
test.after(() => vite.close())

function fakeWindow(light) {
  const listeners = new Set()
  const mq = { get matches() { return light.value }, addEventListener: (_t, fn) => listeners.add(fn), removeEventListener: (_t, fn) => listeners.delete(fn) }
  return { listeners, matchMedia: (q) => (assert.equal(q, '(prefers-color-scheme: light)'), mq), document: { documentElement: { dataset: {} } } }
}

test('the document takes the OS theme: light only when the OS asks for light', () => {
  const win = fakeWindow({ value: false })
  applyTheme(win)
  assert.equal(win.document.documentElement.dataset.theme, 'dark')
  const lightWin = fakeWindow({ value: true })
  applyTheme(lightWin)
  assert.equal(lightWin.document.documentElement.dataset.theme, 'light')
})

test('it follows OS changes while running and stops when disposed', () => {
  const light = { value: false }
  const win = fakeWindow(light)
  const stop = watchSystemTheme(win)
  assert.equal(win.document.documentElement.dataset.theme, 'dark')
  light.value = true
  for (const fn of win.listeners) fn()
  assert.equal(win.document.documentElement.dataset.theme, 'light')
  stop()
  assert.equal(win.listeners.size, 0)
})

test('without matchMedia the app stays dark', () => {
  const win = { document: { documentElement: { dataset: {} } } }
  applyTheme(win)
  assert.equal(win.document.documentElement.dataset.theme, 'dark')
})
