import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

// The workspace sidebar lists agents and teams under the task list. A row only
// opens the agent detail or the team room: it never starts or resumes a task.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { sidebarRows, SidebarAgentsView, SIDEBAR_MAX } = await vite.ssrLoadModule('/src/agent/SidebarAgents.tsx')
const nav = await vite.ssrLoadModule('/src/agent/agent-nav.ts')
test.after(() => vite.close())

const noop = () => {}
const idle = { running: 0, awaitingUser: 0, hasUnread: false, lastConversation: null }
const stamp = { generation: 1, createdAt: 'now', updatedAt: 'now', archived: false, pinned: false }
const avatar = { shape: 'circle', color: 'green' }
const agent = (id, name, extra = {}) => ({ ...stamp, id, name, title: '', description: '', avatar, instructions: '', capabilityId: 'browser', mcpProviders: null, status: idle, ...extra })
const team = (id, name, members, extra = {}) => ({ ...stamp, id, name, title: '', description: '', avatar, memberAgentIds: members, status: idle, ...extra })

test('rows keep pinned first and archived last, and carry status, unread and the replying member', () => {
  const roster = {
    agents: [agent('a1', 'Old', { archived: true }), agent('a2', 'Haiku'), agent('a3', 'Pinned', { pinned: true }), agent('a4', 'Busy', { status: { ...idle, running: 1 } })],
    teams: [team('t1', 'Room', ['a2', 'a3'], { status: { ...idle, hasUnread: true } })],
  }
  const rooms = [{ roomId: 'r1', teamId: 't1', name: 'Room', archived: false, lastMessage: null, active: true }]
  const rows = sidebarRows(roster, rooms, { r1: 'a2' })
  assert.deepEqual(rows.agents.map((r) => r.id), ['a3', 'a2', 'a4', 'a1'])
  assert.equal(rows.agents.find((r) => r.id === 'a1').state, 'archived')
  assert.equal(rows.agents.find((r) => r.id === 'a4').state, 'working')
  assert.equal(rows.agents.find((r) => r.id === 'a2').state, 'idle')
  const room = rows.teams[0]
  assert.equal(room.state, 'working', 'an active round counts as working')
  assert.equal(room.unread, true)
  assert.equal(room.replying, 'Haiku')
  assert.deepEqual(room.members.map((m) => m.id), ['a2', 'a3'])
})

test('the view renders both sections with rows that only open', () => {
  const rows = sidebarRows({ agents: [agent('a2', 'Haiku')], teams: [team('t1', 'Room', ['a2'], { status: { ...idle, hasUnread: true } })] }, [], {})
  const html = renderToStaticMarkup(React.createElement(SidebarAgentsView, { rows, loaded: true, onOpen: noop, onSeeAll: noop, onNew: noop }))
  assert.match(html, />Agents</)
  assert.match(html, />Teams</)
  assert.match(html, /aria-label="New agent"/)
  assert.match(html, /aria-label="New team"/)
  assert.match(html, /data-owner="agent:a2"/)
  assert.match(html, /data-owner="team:t1"/)
  assert.match(html, /aria-label="Unread"/)
  assert.doesNotMatch(html, /data-task-id|data-state=/, 'agent rows are not task rows')
})

test('empty sections say so once loaded, and long lists link to the hub', () => {
  const empty = renderToStaticMarkup(React.createElement(SidebarAgentsView, { rows: { agents: [], teams: [] }, loaded: true, onOpen: noop, onSeeAll: noop, onNew: noop }))
  assert.match(empty, /No agents yet/)
  assert.match(empty, /No teams yet/)
  const many = Array.from({ length: SIDEBAR_MAX + 2 }, (_, i) => agent(`a${i}`, `Agent ${i}`))
  const html = renderToStaticMarkup(React.createElement(SidebarAgentsView, { rows: sidebarRows({ agents: many, teams: [] }, [], {}), loaded: true, onOpen: noop, onSeeAll: noop, onNew: noop }))
  assert.equal((html.match(/data-owner="agent:/g) ?? []).length, SIDEBAR_MAX)
  assert.match(html, new RegExp(`See all ${SIDEBAR_MAX + 2}`))
})

test('a sidebar request is handed to the agent home once', () => {
  const seen = []
  const off = nav.onAgentView((view) => seen.push(view))
  nav.openAgentView({ n: 'detail', owner: { kind: 'team', id: 't1' } })
  off()
  assert.deepEqual(seen, [{ n: 'detail', owner: { kind: 'team', id: 't1' } }])
  assert.deepEqual(nav.takeAgentView(), { n: 'detail', owner: { kind: 'team', id: 't1' } })
  assert.equal(nav.takeAgentView(), null)
})

test('the home screen opens in Agent mode when the sidebar asked for an agent view', () => {
  assert.equal(nav.homeModeFor('task'), 'task')
  nav.openAgentView({ n: 'hub' })
  assert.equal(nav.homeModeFor('task'), 'agent', 'a pending sidebar request wins over the last-used mode')
  nav.takeAgentView()
  assert.equal(nav.homeModeFor('agent'), 'agent')
})

test('the workspace sidebar places the agents block after the task list', async () => {
  const { WorkspaceSidebar } = await vite.ssrLoadModule('/src/components/WorkspaceSidebar.tsx')
  const html = renderToStaticMarkup(React.createElement(WorkspaceSidebar, {
    tasks: [], activeTaskId: null, open: true, onNewTask: noop, onSelectTask: noop,
    agents: React.createElement('p', { id: 'agents-slot' }, 'slot'),
  }))
  assert.ok(html.indexOf('Recent tasks') < html.indexOf('agents-slot'))
  assert.ok(html.indexOf('agents-slot') < html.indexOf('hx-sidebar__foot'))
})
