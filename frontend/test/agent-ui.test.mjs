import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const api = await vite.ssrLoadModule('/src/agent/agent-api.ts')
const norm = await vite.ssrLoadModule('/src/agent/normalize.ts')
const { ModeSwitch } = await vite.ssrLoadModule('/src/agent/AgentHome.tsx')
const { ChildPlanPanel } = await vite.ssrLoadModule('/src/agent/ChildPlanPanel.tsx')
const { RuntimeStatus } = await vite.ssrLoadModule('/src/agent/BackgroundRuntimePanel.tsx')
const { ScheduleEditor } = await vite.ssrLoadModule('/src/agent/AgentSettings.tsx')
const room = await vite.ssrLoadModule('/src/agent/Room.tsx')
const BO = '33333333-3333-4333-8333-333333333333'
test.after(() => vite.close())

const AGENT = '11111111-1111-4111-8111-111111111111'
const TEAM = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
const agent = { id: AGENT, name: 'Scout', title: 'Research', description: '', avatar: { shape: 'star', color: 'blue' }, instructions: 'Be brief', capabilityId: 'browser', mcpProviders: null, generation: 2, createdAt: 'a', updatedAt: 'b', archived: false, pinned: false }

function recorder() {
  const calls = []
  const handler = { get: (_, name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(name === 'startAgentTask' ? { taskId: TASK } : {}) } }
  return { calls, api: new Proxy({}, handler) }
}

test('the agent API gate needs every method the preload really exposes', () => {
  const full = Object.fromEntries(api.AGENT_METHODS.map((name) => [name, () => {}]))
  assert.equal(api.agentApiFrom(full), full)
  for (const name of ['listAgents', 'archiveTeam', 'setAgentPinned', 'listMcpProviders', 'onAgentRosterEvent']) {
    const partial = { ...full }; delete partial[name]
    assert.equal(api.agentApiFrom(partial), null, name)
  }
  assert.equal(api.agentApiFrom(undefined), null)
})

test('calls use the host signatures, not the hand-off assumptions', async () => {
  const { calls, api: fake } = recorder()
  await api.startTask(fake, { kind: 'agent', id: AGENT }, 'find flights')
  await api.markRead(fake, { kind: 'team', id: TEAM })
  await api.setPinned(fake, { kind: 'agent', id: AGENT }, true)
  await api.saveMcpScope(fake, agent, ['codex'])
  assert.deepEqual(calls, [
    ['startAgentTask', { agentId: AGENT, request: 'find flights' }],
    ['markAgentConversationsRead', { teamId: TEAM }],
    ['setAgentPinned', { kind: 'agent', id: AGENT, pinned: true }],
    ['saveAgent', { id: AGENT, name: 'Scout', title: 'Research', description: '', avatar: { shape: 'star', color: 'blue' }, instructions: 'Be brief', capabilityId: 'browser', mcpProviders: ['codex'] }],
  ])
})

test('an edited agent keeps its own capability and never sends bookkeeping fields', () => {
  const input = api.agentInput({ ...agent, capabilityId: 'research' }, { name: ' Scout 2 ', title: 'R', description: 'd', instructions: 'i', avatar: agent.avatar })
  assert.deepEqual(input, { id: AGENT, name: 'Scout 2', title: 'R', description: 'd', avatar: agent.avatar, instructions: 'i', capabilityId: 'research' })
  assert.equal(api.agentInput(undefined, { name: 'New', title: '', description: '', instructions: '', avatar: agent.avatar }).capabilityId, 'browser')
})

test('error text prefers a known code and otherwise strips the IPC prefix', () => {
  assert.match(api.errText({ code: 'limit_reached' }), /Limit reached/)
  assert.equal(api.errText(new Error("Error invoking remote method 'halo:saveAgent': AgentStoreError: at most 50 agents can be saved")), 'at most 50 agents can be saved')
  assert.equal(api.errText(null), 'Something went wrong. Try again.')
  // The host now carries the code in the message as "[code] message".
  assert.match(api.errText(new Error("Error invoking remote method 'halo:saveAgent': Error: [limit_reached] at most 50 agents can be saved")), /Limit reached/)
  assert.equal(api.errText(new Error("Error invoking remote method 'halo:setAgentPinned': Error: [invalid_pin] pinned must be a boolean")), 'pinned must be a boolean')
})

test('schedules round-trip through the host input fields only', () => {
  const record = { id: 'sid', kind: 'agent', ownerId: AGENT, request: 'morning brief', trigger: { kind: 'calendar', days: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Asia/Seoul' }, onApproval: 'pause', maxPlannerCalls: 40, enabled: true, disabledReason: null, armedAt: 'x', createdAt: 'x', updatedAt: 'x', lastOccurrenceAt: null, lastTaskId: null, lastError: null, consecutiveFailures: 0, skippedCount: 0 }
  assert.deepEqual(api.scheduleInput(record), { id: 'sid', kind: 'agent', ownerId: AGENT, request: 'morning brief', trigger: record.trigger, onApproval: 'pause', maxPlannerCalls: 40, enabled: true })
  assert.deepEqual(api.schedulesFor([record, { ...record, id: 'other', ownerId: TEAM, kind: 'team' }], { kind: 'agent', id: AGENT }).map((s) => s.id), ['sid'])
  const blank = api.blankSchedule({ kind: 'team', id: TEAM }, 'Europe/London')
  assert.deepEqual(blank, { kind: 'team', ownerId: TEAM, request: '', trigger: { kind: 'calendar', days: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Europe/London' }, onApproval: 'pause', maxPlannerCalls: 40, enabled: true })
  assert.equal(api.scheduleLabel({ kind: 'interval', everyMs: 3_600_000, anchor: 'x' }), 'every 60 min')
  assert.equal(api.scheduleLabel(record.trigger), 'weekdays, 09:00')
})

test('conversation rows map host state and derive unread from the read marker', () => {
  const row = (state, seenState) => ({ taskId: TASK, kind: 'agent', ownerId: AGENT, generation: 1, createdAt: '2026-10-02T00:00:00.000Z', seenState, task: { taskId: TASK, originalRequest: 'book', state, pauseReason: null, active: false } })
  assert.deepEqual(norm.toUi(row('completed', null)).task, { title: 'book', status: 'done' })
  assert.equal(norm.toUi(row('completed', null)).unread, true)
  assert.equal(norm.toUi(row('completed', 'completed')).unread, false)
  assert.equal(norm.toUi(row('running', null)).unread, false, 'a task still in progress is not unread')
  assert.equal(norm.toUi(row('paused', null)).task.status, 'waiting')
  assert.equal(norm.toUi({ ...row('running', null), task: null }).task, null)
})

test('roster status becomes one dot per owner', () => {
  const status = (running, awaitingUser, hasUnread) => ({ running, awaitingUser, hasUnread, lastConversation: null })
  assert.equal(norm.rosterDot(status(1, 1, true)), 'working')
  assert.equal(norm.rosterDot(status(0, 1, false)), 'unread')
  assert.equal(norm.rosterDot(status(0, 0, true)), 'unread')
  assert.equal(norm.rosterDot(status(0, 0, false)), 'idle')
  assert.equal(norm.rosterDot(undefined), 'idle')
})

test('the mode switch stays hidden without the agent API', () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModeSwitch, { mode: 'task', onChange: () => {} })), '')
})

test('the child plan panel lists host statuses read-only', () => {
  const html = renderToStaticMarkup(React.createElement(ChildPlanPanel, { plan: {
    requestedAgentCount: 2, activeAgentCount: 1, queuedAgentCount: 0, parentGoalVersion: 1, memoryPolicy: 'budgeted',
    agents: [
      { agentId: 'c1', status: 'completed', assignedOrigin: 'https://a.test', evidenceCount: 0, subgoal: 'Compare flight prices' },
      { agentId: 'c2', status: 'waiting_for_review', assignedOrigin: 'https://b.test', evidenceCount: 0, reason: 'needs you' },
    ],
  } }))
  assert.match(html, /1 of 2 done/)
  assert.match(html, /Needs review/)
  assert.match(html, /needs you/)
  assert.match(html, /<b>Compare flight prices<\/b>/, 'a child is named by its subgoal')
  assert.match(html, /<b>c2<\/b>/, 'the id is the fallback name')
  assert.doesNotMatch(html, /<input|<select/)
  assert.equal(renderToStaticMarkup(React.createElement(ChildPlanPanel, { plan: null })), '')
})

test('the sub-task panel shows the team board, naming each post by its agent job', () => {
  const plan = { requestedAgentCount: 2, activeAgentCount: 2, queuedAgentCount: 0, parentGoalVersion: 1, memoryPolicy: 'budgeted', agents: [
    { agentId: 'a', status: 'running', assignedOrigin: 'https://a.test', evidenceCount: 0, subgoal: 'Flights' },
    { agentId: 'b', status: 'running', assignedOrigin: 'https://b.test', evidenceCount: 0 },
  ] }
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ChildPlanPanel, { plan })), /Team board/)
  const html = renderToStaticMarkup(React.createElement(ChildPlanPanel, { plan: { ...plan, board: [
    { entryId: 'e1', agentId: 'a', kind: 'progress', text: 'KE123 is cheapest', at: '2026-10-02T00:00:00.000Z' },
    { entryId: 'e2', agentId: 'b', kind: 'handoff', text: '<b>done</b>', at: '2026-10-02T00:01:00.000Z' },
  ] } }))
  assert.match(html, /Team board/)
  assert.match(html, /Flights[\s\S]*KE123 is cheapest/)
  assert.match(html, /Agent 2/)
  assert.match(html, /&lt;b&gt;done&lt;\/b&gt;/, 'post text is rendered as text')
})

test('the runtime status offers only the actions the host supports', () => {
  const connected = renderToStaticMarkup(React.createElement(RuntimeStatus, { state: { connection: 'connected', service: 'running', memoryPolicy: 'budgeted', error: null }, onStop: () => {}, onPolicy: () => {} }))
  assert.match(connected, /Background service connected/)
  assert.match(connected, /Stop service/)
  assert.doesNotMatch(connected, />Start</)
  assert.doesNotMatch(connected, /Start at login/, 'install state is unknown, so nothing is claimed')
  const local = renderToStaticMarkup(React.createElement(RuntimeStatus, { state: { connection: 'disconnected', service: 'stopped', memoryPolicy: 'user_override', launchAgentInstalled: false, error: null }, onStop: () => {}, onPolicy: () => {} }))
  assert.doesNotMatch(local, /Stop service/)
  assert.match(local, /schedules won(?:'|&#x27;)t run/i)
  assert.match(local, /Launch agent not installed/)
  assert.match(local, /aria-checked="true"[^>]*>.*Override/s)
})

test('start at login is offered only when the host reports the launch agent and can change it', () => {
  const base = { connection: 'disconnected', service: 'stopped', memoryPolicy: 'budgeted', error: null }
  const render = (state, extra = {}) => renderToStaticMarkup(React.createElement(RuntimeStatus, { state: { ...base, ...state }, onStop: () => {}, onPolicy: () => {}, ...extra }))
  assert.doesNotMatch(render({ launchAgentInstalled: false }), /Start at login/, 'no toggle without a handler')
  const off = render({ launchAgentInstalled: false }, { onLaunchAtLogin: () => {} })
  assert.match(off, /Start at login/)
  assert.match(off, /role="switch"[^>]*aria-checked="false"/)
  const on = render({ launchAgentInstalled: true }, { onLaunchAtLogin: () => {} })
  assert.match(on, /role="switch"[^>]*aria-checked="true"/)
  assert.doesNotMatch(render({}, { onLaunchAtLogin: () => {} }), /Start at login/, 'unknown install state claims nothing')
})

test('every trigger kind can be built and checked against the host limits', () => {
  const now = Date.parse('2026-10-02T03:00:00.000Z')
  assert.deepEqual(api.switchTrigger('interval', 'UTC', now), { kind: 'interval', everyMs: 3_600_000, anchor: '2026-10-02T03:00:00.000Z' })
  assert.deepEqual(api.switchTrigger('once', 'UTC', now), { kind: 'once', at: '2026-10-02T04:00:00.000Z' })
  assert.deepEqual(api.switchTrigger('calendar', 'Asia/Seoul', now), { kind: 'calendar', days: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Asia/Seoul' })
  assert.equal(api.triggerProblem({ kind: 'interval', everyMs: 59_999, anchor: 'x' }, now), 'Repeat at least every minute.')
  assert.equal(api.triggerProblem({ kind: 'interval', everyMs: 367 * 86_400_000, anchor: 'x' }, now), 'Repeat at most once a year.')
  assert.equal(api.triggerProblem({ kind: 'interval', everyMs: 60_000, anchor: 'x' }, now), null)
  assert.equal(api.triggerProblem({ kind: 'once', at: '2026-10-02T02:59:00.000Z' }, now), 'Pick a time in the future.')
  assert.equal(api.triggerProblem({ kind: 'once', at: 'nope' }, now), 'Pick a time in the future.')
  assert.equal(api.triggerProblem({ kind: 'once', at: '2026-10-02T05:00:00.000Z' }, now), null)
  assert.equal(api.triggerProblem({ kind: 'calendar', days: [], time: '09:00', timeZone: 'UTC' }, now), 'Pick at least one day.')
  assert.equal(api.triggerProblem({ kind: 'calendar', days: [1], time: '9:00', timeZone: 'UTC' }, now), 'Use a time like 09:00.')
  // datetime-local round trip stays on the same instant.
  const iso = '2026-10-02T04:30:00.000Z'
  assert.equal(api.fromLocalInput(api.toLocalInput(iso)), iso)
  assert.equal(api.fromLocalInput(''), null)
})

test('the schedule editor edits interval and one-time schedules too', () => {
  const base = { kind: 'agent', ownerId: AGENT, request: 'check inbox', onApproval: 'pause', maxPlannerCalls: 40, enabled: true }
  const render = (trigger) => renderToStaticMarkup(React.createElement(ScheduleEditor, { initial: { ...base, trigger }, error: null, onSave: () => {}, onCancel: () => {} }))
  const interval = render({ kind: 'interval', everyMs: 5_400_000, anchor: '2026-10-02T03:00:00.000Z' })
  assert.match(interval, /aria-label="Repeat"/)
  assert.match(interval, /aria-checked="true"[^>]*>Every/)
  assert.match(interval, /type="number"[^>]*value="90"/)
  assert.doesNotMatch(interval, /not edited|can.t be edited/)
  const once = render({ kind: 'once', at: '2099-01-01T00:00:00.000Z' })
  assert.match(once, /type="datetime-local"/)
  assert.match(once, /aria-checked="true"[^>]*>Once/)
  const calendar = render({ kind: 'calendar', days: [1], time: '09:00', timeZone: 'UTC' })
  assert.match(calendar, /aria-label="Days"/)
})


test('the room API is optional and gated on every room method', () => {
  const full = { listRooms() {}, getRoom() {}, postRoomMessage() {}, stopRoomRound() {}, onRoomEvent() {} }
  assert.equal(api.roomApiFrom(full), full)
  assert.equal(api.roomApiFrom({ ...full, onRoomEvent: undefined }), null)
  assert.equal(api.roomApiFrom(null), null)
})

test('room events merge by message id and track the round', () => {
  const m = (id, text) => ({ messageId: id, roomId: TEAM, author: 'user', kind: 'say', text, at: '2026-10-02T00:00:00.000Z' })
  let state = { messages: [m('1', 'a')], round: { active: false, turn: 0, speakerId: null } }
  state = api.applyRoomEvent(state, TEAM, { roomId: TEAM, message: m('2', 'b') })
  state = api.applyRoomEvent(state, TEAM, { roomId: TEAM, message: m('2', 'b') })
  state = api.applyRoomEvent(state, TEAM, { roomId: 'other', message: m('3', 'c') })
  state = api.applyRoomEvent(state, TEAM, { roomId: TEAM, round: { active: true, turn: 1, speakerId: AGENT } })
  assert.deepEqual(state.messages.map((x) => x.text), ['a', 'b'])
  assert.deepEqual(state.round, { active: true, turn: 1, speakerId: AGENT })
})

test('the transcript names speakers, hides passes, and links started tasks', () => {
  const agents = [{ id: AGENT, name: 'Ann', avatar: { shape: 'circle', color: 'blue' } }, { id: BO, name: 'Bo', avatar: { shape: 'star', color: 'red' } }]
  const at = '2026-10-02T00:00:00.000Z'
  const messages = [
    { messageId: '1', roomId: TEAM, author: 'user', kind: 'say', text: 'Plan Jeju', at },
    { messageId: '2', roomId: TEAM, author: AGENT, kind: 'say', text: 'Flights first.', at },
    { messageId: '3', roomId: TEAM, author: BO, kind: 'pass', text: '', at },
    { messageId: '4', roomId: TEAM, author: AGENT, kind: 'propose_task', text: 'Search flights', at },
    { messageId: '5', roomId: TEAM, author: 'host', kind: 'task_started', text: 'Search flights', taskId: 'task-1', originMessageId: '1', at },
    { messageId: '6', roomId: TEAM, author: '44444444-4444-4444-8444-444444444444', kind: 'say', text: 'old', at },
  ]
  const html = renderToStaticMarkup(React.createElement(room.RoomTranscript, { messages, agents, round: { active: true, turn: 2, speakerId: BO }, onOpenTask: () => {} }))
  assert.match(html, /Plan Jeju/)
  assert.match(html, /<b>Ann<\/b>/)
  assert.doesNotMatch(html, /<b>Bo<\/b>[^<]*<\/span><p>/, 'a pass is not shown as a message')
  assert.match(html, /Proposed a task/)
  assert.match(html, /Task started/)
  assert.match(html, /Open task/)
  assert.match(html, /Removed agent/)
  assert.match(html, /Bo is replying/)
})

test('Design System-6: the mode switch is the draggable glass toggle with its thumb on the selected side', () => {
  globalThis.haloBrowser = recorder().api
  try {
    const task = renderToStaticMarkup(React.createElement(ModeSwitch, { mode: 'task', onChange: () => {} }))
    const agentHtml = renderToStaticMarkup(React.createElement(ModeSwitch, { mode: 'agent', onChange: () => {} }))
    assert.match(task, /class="hx-lg hx-gl"/)
    assert.match(task, /--x:0px/)
    assert.match(agentHtml, /--x:84px/)
    assert.match(agentHtml, /aria-pressed="true"[^>]*>Agent</)
    assert.match(task, /role="group" aria-label="Home mode"/)
  } finally {
    delete globalThis.haloBrowser
  }
})

test('Design System-6: avatars are faced characters on an 80x80 canvas, and the plan is headed by the orchestrator mark', async () => {
  const ui = await vite.ssrLoadModule('/src/agent/AgentUi.tsx')
  for (const shape of ui.SHAPES) {
    const html = renderToStaticMarkup(React.createElement(ui.Shape, { shape, color: 'blue', size: 40 }))
    assert.match(html, /viewBox="0 0 80 80"/, shape)
    assert.match(html, /ff8fa3/, `${shape} has blush cheeks`)
  }
  assert.match(renderToStaticMarkup(React.createElement(ui.OrchestratorMark, {})), /viewBox="0 0 80 80"/)
  const plan = { requestedAgentCount: 2, activeAgentCount: 1, queuedAgentCount: 1, parentGoalVersion: 1, memoryPolicy: 'budgeted', agents: [
    { agentId: 'abcdef123456', status: 'running', assignedOrigin: 'https://a.test', evidenceCount: 0, subgoal: 'Flights' },
    { agentId: '99887766aaaa', status: 'queued', assignedOrigin: 'https://b.test', evidenceCount: 0 },
  ] }
  const html = renderToStaticMarkup(React.createElement(ChildPlanPanel, { plan, agents: [{ ...agent, id: '99887766aaaa', name: 'Scout' }] }))
  assert.match(html, /<header><svg viewBox="0 0 80 80"/, 'orchestrator mark heads the plan')
  assert.match(html, /<b>Flights<\/b>/, 'the parent-authored job still names a child')
  assert.match(html, /<b>Scout<\/b>/, 'a child that is a known agent shows its name')
  assert.equal((html.match(/class="hx-av"/g) || []).length, 2, 'every row has an avatar')
  const bare = renderToStaticMarkup(React.createElement(ChildPlanPanel, { plan: { ...plan, agents: [plan.agents[0], { ...plan.agents[1] }] } }))
  assert.match(bare, /<b>998877<\/b>/, 'an unknown child without a job falls back to its id prefix')
})

test('an agent can pin a planner model from the host allowlists; Host default sends null', async () => {
  const { AgentForm } = await vite.ssrLoadModule('/src/agent/AgentForms.tsx')
  const fields = { name: 'Scout', title: '', description: '', instructions: '', avatar: agent.avatar }
  assert.equal(api.agentInput(agent, { ...fields, model: 'gpt-6.1-sol' }).model, 'gpt-6.1-sol')
  assert.equal(api.agentInput(agent, { ...fields, model: null }).model, null)
  assert.equal('model' in api.agentInput(agent, fields), false, 'an edit without the field keeps the saved model')
  const html = renderToStaticMarkup(React.createElement(AgentForm, { api: {}, agent: { ...agent, model: 'claude-sonnet-5-5' }, onBack: () => {}, onSaved: () => {} }))
  assert.match(html, /<select[^>]*aria-label="Agent model"/)
  assert.match(html, /<option value="">Host default<\/option>/)
  assert.match(html, /<optgroup label="Claude">[\s\S]*Sonnet 5\.5[\s\S]*<optgroup label="Codex">[\s\S]*GPT-6\.1 Sol/)
  assert.match(html, /<option value="claude-sonnet-5-5" selected="">/)
})
