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
    onHelp: noop,
    controller: null,
    halo: null,
  }))
  assert.match(html, /aria-label="Address"/)
  assert.match(html, /hx-omni__form/)
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
