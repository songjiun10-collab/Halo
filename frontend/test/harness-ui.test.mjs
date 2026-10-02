import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const noop = () => {}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { HaloChat } = await vite.ssrLoadModule('/src/components/HaloChat.tsx')
const { HaloSheet } = await vite.ssrLoadModule('/src/components/HaloSheet.tsx')
const { Toolbar } = await vite.ssrLoadModule('/src/components/Toolbar.tsx')
const { nonEmptyVerbatim } = await vite.ssrLoadModule('/src/session/composer.ts')
test.after(() => vite.close())

test('approval sheet exposes its task-scoped approval identity', () => {
  const html = renderToStaticMarkup(React.createElement(HaloSheet, {
    approval: { taskId: 'task-1', id: 'approval-7', action: 'Open page', request: 'navigate', createdAt: 'now' },
    onApprove: noop,
    onDeny: noop,
    onTakeOver: noop,
  }))
  assert.match(html, /data-approval-id="approval-7"/)
})

test('toolbar exposes a real address entry form for the active browser surface', () => {
  const html = renderToStaticMarkup(React.createElement(Toolbar, {
    tab: { id: 'page', history: ['https://example.com/'], index: 0, canGoBack: false, canGoForward: false },
    folded: false,
    locked: false,
    omniRef: null,
    onBack: noop,
    onForward: noop,
    onShare: noop,
    onOverview: noop,
    onActivity: noop,
    onNavigate: noop,
    onNewWindow: noop,
    controller: null,
    halo: null,
  }))
  assert.match(html, /aria-label="Address"/)
  assert.match(html, /hx-omni__form/)
  assert.doesNotMatch(html, /Keyboard shortcuts/, 'the toolbar has no shortcuts button; Shift+? still opens the list')
})

test('chat presents task switching and pending evidence as real controls', () => {
  const html = renderToStaticMarkup(React.createElement(HaloChat, {
    taskLabel: 'Current goal',
    messages: [],
    recentTasks: [{ taskId: 'task-old', label: 'Earlier goal', meta: 'completed' }],
    pendingCriteria: [{ taskId: 'task-current', criterionId: 'C1', text: 'Reach the result page', goalVersion: 1, evidenceId: 'e1' }],
    isTaskActive: true,
    leaving: false,
    onClose: noop,
    onSend: noop,
    onSelectTask: noop,
    onNewTask: noop,
    onConfirmCriterion: noop,
  }))
  assert.match(html, /data-task-id="task-old"/)
  assert.match(html, /aria-label="New task"/)
  assert.match(html, /Confirm criterion C1/)
  assert.match(html, /data-evidence-id="e1"/)
  assert.match(html, /goal update/i)
})


test('composer rejects whitespace-only input but preserves accepted text exactly', () => {
  assert.equal(nonEmptyVerbatim(' \t '), null)
  assert.equal(nonEmptyVerbatim('  keep these edges  '), '  keep these edges  ')
})

test('the Halo button never folds away; only the controller chip does', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const file of ['src/styles/app.css', 'src/styles/design-system/components.css']) {
    const css = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const rule of css.match(/\.hx-toolbar\[data-folded\][^{]*\{/g) ?? []) assert.doesNotMatch(rule, /hx-halo/, `${file}: ${rule}`)
  }
})

test('chat bubbles keep words whole and only wrap at the panel edge', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile(new URL('../src/styles/app.css', import.meta.url), 'utf8')
  const rule = css.match(/\.hx-msg p \{[^}]*\}/)[0]
  assert.doesNotMatch(rule, /overflow-wrap:\s*anywhere/, 'anywhere lets the bubble shrink and split every word')
  assert.match(rule, /word-break:\s*keep-all/)
  assert.match(rule, /width:\s*fit-content/)
  // A percentage max-width resolves against the shrink-to-fit bubble itself, so it always wraps the last character.
  assert.doesNotMatch(rule, /max-width:\s*\d+%/)
})

test('the page stays visible as a snapshot while an overlay hides the native view', async () => {
  const fs = await import('node:fs/promises')
  const app = await fs.readFile(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /captureSnapshot\(/, 'a still is taken before the native view is hidden')
  assert.match(app, /className="hx-snapshot"/)
  const css = await fs.readFile(path.join(root, 'src/styles/app.css'), 'utf8')
  assert.match(css, /\.hx-snapshot\s*\{[^}]*pointer-events:\s*none/, 'the still is not interactive')
})
