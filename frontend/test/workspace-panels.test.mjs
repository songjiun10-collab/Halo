import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const ws = await vite.ssrLoadModule('/src/agent/workspace-api.ts')
const sections = await vite.ssrLoadModule('/src/agent/WorkspacePanels.tsx')
const { UsageView, MemoryView, RoutineList, RoutineEditor } = await vite.ssrLoadModule('/src/agent/WorkspacePanels.tsx')
test.after(() => vite.close())

const R = '44444444-4444-4444-8444-444444444444'
const totals = (input, output, cost) => ({ calls: 2, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: cost, durationMs: 10 })
const usage = {
  byProvider: { claude: totals(1000, 500, 0.5), codex: totals(0, 0, 0) },
  imported: { claude: { provider: 'claude', sessions: 4, inputTokens: 1_200_000, outputTokens: 300_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 12.345, firstAt: 1, lastAt: 2, syncedAt: 3 } },
  subscription: {
    claude: { provider: 'claude', windows: { session: { usedPercent: 42, resetsAt: '2026-10-02T12:00:00.000Z' }, week: { usedPercent: 7.5, resetsAt: null }, weekSonnet: null, weekOpus: null }, asOf: 5 },
    codex: { provider: 'codex', windows: { primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 1_790_000_000 }, secondary: null }, asOf: 6 },
  },
  limits: {
    claude: { limit: { tokens: 2_000_000, costUsd: null }, exceeded: false, basis: 'imported', remainingTokens: 500_000, tokensUsedRatio: 0.75 },
    codex: { limit: { tokens: null, costUsd: 5 }, exceeded: true, basis: 'harness', remainingCostUsd: 0, costUsedRatio: 1 },
  },
}

test('usage rows prefer the CLI-imported totals and carry plan windows and limits', () => {
  const [claude, codex] = ws.usageRows(usage)
  assert.equal(claude.provider, 'claude')
  assert.equal(claude.basis, 'imported')
  assert.equal(claude.tokens, 1_500_000)
  assert.equal(claude.costUsd, 12.345)
  assert.deepEqual(claude.windows.map((w) => [w.label, w.usedPercent]), [['Current session', 42], ['This week', 7.5]])
  assert.equal(codex.basis, 'harness')
  assert.equal(codex.tokens, 0)
  assert.deepEqual(codex.windows.map((w) => [w.label, w.usedPercent]), [['5h window', 10]])
  assert.equal(codex.exceeded, true)
  assert.equal(ws.formatTokens(1_500_000), '1.5M')
  assert.equal(ws.formatTokens(12_300), '12.3K')
  assert.equal(ws.formatTokens(999), '999')
})

test('limit input accepts blank as no limit and rejects non-positive numbers', () => {
  assert.deepEqual(ws.limitPatch('2000000', ''), { tokens: 2_000_000, costUsd: null })
  assert.deepEqual(ws.limitPatch(' ', '7.5'), { tokens: null, costUsd: 7.5 })
  assert.throws(() => ws.limitPatch('-1', ''), /positive/)
  assert.throws(() => ws.limitPatch('', 'abc'), /positive/)
})

test('the usage view renders totals, plan bars, the limit state and a sync button', () => {
  const html = renderToStaticMarkup(React.createElement(UsageView, { usage, busy: false, onSync: () => {}, onSaveLimit: () => {} }))
  assert.match(html, /Claude[\s\S]*1\.5M tokens[\s\S]*\$12\.35/)
  assert.match(html, /From the Claude CLI/)
  assert.match(html, /Current session[\s\S]*42%/)
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="42"/)
  assert.match(html, /Codex[\s\S]*Limit reached/)
  assert.match(html, /<button[^>]*>Sync from CLIs<\/button>/)
  assert.match(html, /<button[^>]*>Set limit<\/button>/)
})

test('memory view lists entries with edit and delete, and shows the entry count', () => {
  const memories = [{ id: 'm1', text: 'Prefers Korean replies', origin: null, createdAt: 'a', updatedAt: 'b' }, { id: 'm2', text: 'Ships on Fridays', origin: 'https://example.com', createdAt: 'a', updatedAt: 'b' }]
  const html = renderToStaticMarkup(React.createElement(MemoryView, { memories, onSave: () => {}, onRemove: () => {} }))
  assert.match(html, /Prefers Korean replies[\s\S]*Ships on Fridays/)
  assert.match(html, /https:\/\/example\.com/)
  assert.match(html, /2\/100/)
  assert.equal(html.match(/>Edit<\/button>/g).length, 2)
  assert.equal(html.match(/>Delete<\/button>/g).length, 2)
  assert.match(html, /aria-label="New memory"/)
})

test('a routine draft derives its origin allowlist from its step URLs', () => {
  const draft = { name: ' Check news ', description: '', steps: [{ kind: 'navigate', url: 'https://news.example.com/top' }, { kind: 'follow_link', name: 'First story', expectedHref: '' }, { kind: 'scroll', direction: 'down', amount: '' }] }
  assert.deepEqual(ws.routineInput(draft), {
    name: 'Check news', description: '', origins: ['https://news.example.com'],
    steps: [{ kind: 'navigate', url: 'https://news.example.com/top' }, { kind: 'follow_link', name: 'First story' }, { kind: 'scroll', direction: 'down' }],
  })
  assert.deepEqual(ws.routineInput({ ...draft, routineId: R }).routineId, R)
  assert.throws(() => ws.routineInput({ ...draft, name: '' }), /name/i)
  assert.throws(() => ws.routineInput({ ...draft, steps: [{ kind: 'scroll', direction: 'down', amount: '' }] }), /Navigate/)
  assert.throws(() => ws.routineInput({ ...draft, steps: [{ kind: 'navigate', url: 'ftp://x' }] }), /http/)
  const back = ws.routineDraft({ routineId: R, revision: 3, name: 'N', description: 'D', origins: ['https://a.com'], steps: [{ kind: 'scroll', direction: 'up', amount: 300 }] })
  assert.deepEqual(back, { routineId: R, name: 'N', description: 'D', steps: [{ kind: 'scroll', direction: 'up', amount: '300' }] })
})

test('routine list and editor render runnable rows and every step kind', () => {
  const routine = { routineId: R, revision: 2, name: 'Morning check', description: 'News', origins: ['https://a.com'], steps: [{ kind: 'navigate', url: 'https://a.com' }], createdAt: 'a', updatedAt: 'b', digest: 'x', schemaVersion: 1 }
  const list = renderToStaticMarkup(React.createElement(RoutineList, { routines: [routine], onRun: () => {}, onEdit: () => {}, onDelete: () => {}, onNew: () => {} }))
  assert.match(list, /Morning check[\s\S]*1 step · v2/)
  assert.match(list, />Run<\/button>[\s\S]*>Edit<\/button>[\s\S]*>Delete<\/button>/)
  assert.match(list, />\+ New routine<\/button>/)
  const editor = renderToStaticMarkup(React.createElement(RoutineEditor, { initial: { name: '', description: '', steps: [{ kind: 'navigate', url: '' }, { kind: 'follow_link', name: '', expectedHref: '' }, { kind: 'scroll', direction: 'down', amount: '' }] }, error: null, onSave: () => {}, onCancel: () => {} }))
  assert.match(editor, /aria-label="Routine name"/)
  assert.match(editor, /aria-label="Step 1 URL"/)
  assert.match(editor, /aria-label="Step 2 link text"/)
  assert.match(editor, /aria-label="Step 3 direction"/)
  assert.match(editor, />\+ Add step<\/button>/)
  assert.match(editor, /<button[^>]*disabled=""[^>]*>Save routine<\/button>/, 'an incomplete draft cannot be saved')
})

test('the Agent home shows each section only when the host exposes its methods', () => {
  const { WorkspaceSections } = sections
  const fn = () => Promise.resolve([])
  globalThis.window = { haloBrowser: { getUsage: fn, setUsageLimit: fn, syncUsage: fn, listRoutines: fn, saveRoutine: fn, deleteRoutine: fn, runRoutine: fn } }
  try {
    const html = renderToStaticMarkup(React.createElement(WorkspaceSections, { onOpenTask: () => {} }))
    assert.match(html, /<h3 class="hx-ag__h">Usage<\/h3>[\s\S]*<h3 class="hx-ag__h">Routines<\/h3>/)
    assert.doesNotMatch(html, />Memory<\/h3>/)
  } finally { delete globalThis.window }
})
