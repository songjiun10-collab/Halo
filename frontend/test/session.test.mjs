import assert from 'node:assert/strict'
import test from 'node:test'
import * as session from '../src/session/session.ts'

const goal = (id, request = id) => ({ schemaVersion: 1, taskId: id, goalVersion: 1, originalRequest: request, amendments: [], constraints: [], criteria: [{ id: 'C1', text: 'Check the result', required: true, verification: 'user' }], limits: { maxActions: 1000, maxPlannerCalls: 500, maxActiveMs: 14400000 }, createdAt: '2026-09-27T00:00:00Z' })
const snapshot = (state = 'running', extra = {}) => ({ state, pauseReason: null, goalVersion: 1, budgets: { actions: 0, plannerCalls: 0, activeMs: 0 }, segment: {}, criteriaStatus: [], approvalQueue: [], ...extra })
const browser = (url = 'https://example.com/') => ({ tabs: [{ id: 'page', url, title: 'Example', canGoBack: false, canGoForward: false }], activeTabId: 'page', documentEpoch: 1 })
const event = (taskId, seq) => ({ seq, eventId: `event-${seq}`, taskId, goalVersion: 1, type: 'note', payload: { msg: `Event ${seq}` }, at: '2026-09-27T00:00:00Z' })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function harness(overrides = {}) {
  let listener
  const api = {
    listTasks: async () => [],
    getTaskDetail: async (id) => ({ taskId: id, goal: goal(id), snapshot: snapshot(), active: true }),
    getTaskBrowser: async () => browser(),
    getTaskEvents: async () => [],
    resumeSavedTask: async () => snapshot(),
    taskApprove: async () => snapshot(),
    taskDeny: async () => snapshot(),
    taskPause: async () => snapshot('paused'),
    taskStop: async () => snapshot('stopped'),
    taskTakeOver: async () => snapshot('paused'),
    confirmCriterion: async () => snapshot(),
    amendTask: async () => snapshot(),
    setTaskViewport: async () => {},
    taskBrowserAction: async () => browser(),
    onTaskEvent: (callback) => { listener = callback; return () => { listener = undefined } },
    ...overrides,
  }
  assert.equal(typeof session.SessionStore, 'function', 'the renderer must have a live harness session')
  const store = new session.SessionStore(api)
  const disconnect = store.connect()
  return { api, store, emit: (payload) => listener?.(payload), disconnect }
}

test('initial state contains no invented task, page, activity, or conversation', () => {
  assert.equal(typeof session.SessionStore, 'function', 'the renderer must have a live harness session')
  const store = new session.SessionStore(undefined)
  assert.deepEqual(store.getState().tasks, [])
  assert.deepEqual(store.getState().tabs, [])
  assert.deepEqual(store.getState().timeline, [])
  assert.deepEqual(store.getState().messages, [])
  assert.equal(store.getState().connected, false)
})

test('late task details and events cannot replace a newer selected task', async () => {
  const first = deferred()
  const { store } = harness({ getTaskDetail: async (id) => id === 'first' ? first.promise : { taskId: id, goal: goal(id), snapshot: snapshot('paused'), active: true } })
  const old = store.selectTask('first')
  await store.selectTask('second')
  first.resolve({ taskId: 'first', goal: goal('first'), snapshot: snapshot(), active: true })
  await old
  assert.equal(store.getState().activeTaskId, 'second')
  assert.equal(store.getState().task, 'second')
  assert.equal(store.getState().snapshot.state, 'paused')
})

test('a pushed snapshot wins over a getTaskDetail response already in flight', async () => {
  const detail = deferred()
  const { store, emit } = harness({ getTaskDetail: () => detail.promise })
  const selecting = store.selectTask('task')
  emit({ taskId: 'task', snapshot: snapshot('awaiting_approval', { approvalQueue: [{ id: 'a1', summary: 'Submit', action: 'click', createdAt: '2026-09-27T00:00:00Z' }] }), goal: goal('task') })
  detail.resolve({ taskId: 'task', goal: goal('task'), snapshot: snapshot(), active: true })
  await selecting
  assert.equal(store.getState().snapshot.state, 'awaiting_approval')
  assert.equal(store.getState().approval.id, 'a1')
})

test('only the current approval head is submitted once and a later push survives its response', async () => {
  const pending = deferred()
  const calls = []
  const { store, emit } = harness({ taskApprove: (...args) => { calls.push(args); return pending.promise } })
  await store.selectTask('task')
  const queue = [{ id: 'a1', summary: 'First action', action: 'click', createdAt: '2026-09-27T00:00:00Z' }, { id: 'a2', summary: 'Second action', action: 'navigate', createdAt: '2026-09-27T00:00:00Z' }]
  emit({ taskId: 'task', snapshot: snapshot('awaiting_approval', { approvalQueue: queue }) })
  const deciding = store.decideApproval('approve', store.getState().approval)
  await store.decideApproval('approve', store.getState().approval)
  emit({ taskId: 'task', snapshot: snapshot('awaiting_approval', { approvalQueue: queue.slice(1) }) })
  pending.resolve(snapshot())
  await deciding
  assert.deepEqual(calls, [['task', 'a1']])
  assert.equal(store.getState().approval.id, 'a2')
})

test('early create events expose the live task before its long-running request completes', async () => {
  const create = deferred()
  const calls = []
  const { store, emit } = harness({ createTask: (input) => { calls.push(input); return create.promise } })
  const creating = store.sendMessage('Find the documentation')
  emit({ taskId: 'new', goal: goal('new', 'Find the documentation'), snapshot: snapshot(), browser: browser() })
  assert.equal(store.getState().activeTaskId, 'new')
  assert.equal(store.getState().busy, null)
  assert.deepEqual(calls, [{ originalRequest: 'Find the documentation' }])
  create.resolve({ taskId: 'new', goal: goal('new', 'Find the documentation'), snapshot: snapshot('paused') })
  await creating
})

test('goal amendment sends the exact allowed input and retains text only from persisted goal', async () => {
  const calls = []
  const amended = { ...goal('task'), goalVersion: 2, amendments: [{ id: 'm1', text: 'Use the official docs', at: '2026-09-27T00:01:00Z', supersedesConstraintIds: [], authority: 'user' }] }
  let saved = goal('task')
  const { store } = harness({ getTaskDetail: async () => ({ taskId: 'task', goal: saved, snapshot: snapshot('paused', { goalVersion: saved.goalVersion }), active: true }), amendTask: async (...args) => { calls.push(args); saved = amended; return snapshot('paused', { goalVersion: 2 }) } })
  await store.selectTask('task')
  await store.sendMessage('Use the official docs')
  assert.deepEqual(calls, [['task', { text: 'Use the official docs', supersedesConstraintIds: [], newConstraints: [], newCriteria: [] }]])
  assert.equal(store.getState().goal.goalVersion, 2)
  assert.equal(store.getState().messages.at(-1).text, 'Use the official docs')
})

test('criterion confirmation carries the displayed goal version and evidence and rejects stale cards', async () => {
  const calls = []
  const { store, emit } = harness({ confirmCriterion: async (...args) => { calls.push(args); return snapshot('completed') } })
  await store.selectTask('task')
  emit({ taskId: 'task', snapshot: snapshot('awaiting_verification', { criteriaStatus: [{ criterionId: 'C1', status: 'pending', goalVersion: 1, evidenceId: 'e1' }] }) })
  const card = session.pendingCriteria(store.getState())[0]
  await store.confirmCriterion(card, 'verified')
  assert.deepEqual(calls, [['task', { criterionId: 'C1', goalVersion: 1, evidenceId: 'e1', outcome: 'verified' }]])
  emit({ taskId: 'task', snapshot: snapshot('awaiting_verification', { criteriaStatus: [{ criterionId: 'C1', status: 'pending', goalVersion: 1, evidenceId: 'e2' }] }) })
  await store.confirmCriterion(card, 'verified')
  assert.equal(calls.length, 1)
})

test('journal catch-up drains pages and another task push cannot mix its history', async () => {
  const cursors = []
  const { store, emit } = harness({ getTaskEvents: async (taskId, { since }) => { cursors.push(since); return since === 0 ? Array.from({ length: 200 }, (_, i) => event(taskId, i + 1)) : since === 200 ? [event(taskId, 201)] : [] } })
  await store.selectTask('task')
  assert.equal(store.getState().timeline.length, 201)
  assert.deepEqual(cursors.slice(0, 2), [0, 200])
  emit({ taskId: 'other', snapshot: snapshot('stopped'), goal: goal('other') })
  await settle()
  assert.equal(store.getState().timeline.length, 201)
  assert.equal(store.getState().activeTaskId, 'task')
})

test('an IPC failure is visible and does not manufacture a successful amendment', async () => {
  const { store } = harness({ amendTask: async () => { throw new Error('Goal is locked') } })
  await store.selectTask('task')
  assert.equal(await store.sendMessage('Do something different'), false)
  assert.match(store.getState().error, /Goal is locked/)
  assert.equal(store.getState().messages.length, 1)
})

test('navigation is denied while the agent owns the page', async () => {
  let calls = 0
  const { store, emit } = harness({ taskBrowserAction: async () => { calls++; return browser('https://example.org/') } })
  await store.selectTask('task')
  await store.navigate({ type: 'navigate', url: 'https://example.org/' })
  assert.equal(calls, 0)
  emit({ taskId: 'task', snapshot: snapshot('paused') })
  await store.navigate({ type: 'navigate', url: 'https://example.org/' })
  assert.equal(calls, 1)
  assert.equal(store.getState().tabs[0].history[0], 'https://example.org/')
})
