import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { FindBar } = await vite.ssrLoadModule('/src/components/FindBar.tsx')
const { SHORTCUTS } = await vite.ssrLoadModule('/src/hooks/useShortcuts.ts')
test.after(() => vite.close())

test('the find bar renders its search contract', () => {
  const html = renderToStaticMarkup(React.createElement(FindBar, { targetTaskId: null, onClose: () => {} }))
  assert.match(html, /aria-label="Find on page"/)
  assert.match(html, /placeholder="Find on page"/)
  assert.match(html, /aria-label="Next match"/)
  assert.match(html, /aria-label="Previous match"/)
  assert.match(html, /aria-label="Close find"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /class="hx-find"/)
})

test('the shortcut table advertises Mod+F for find on page', () => {
  assert.ok(SHORTCUTS.some((s) => s.keys === 'Mod+F' && /find/i.test(s.label)), 'Mod+F must be listed in the help table')
})

test('the shortcut table advertises the zoom keys', () => {
  for (const key of ['Mod+=', 'Mod+-', 'Mod+0']) {
    assert.ok(SHORTCUTS.some((s) => s.keys === key), `${key} must be listed in the help table`)
  }
})
