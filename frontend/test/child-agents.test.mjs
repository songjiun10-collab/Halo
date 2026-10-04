import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeChildPlan } from '../src/session/child-agents.ts'

test('renders parent-proposed count and one status per unique child without changing the count', () => {
  const plan = summarizeChildPlan({
    requestedAgentCount: 3,
    activeAgentCount: 1,
    queuedAgentCount: 2,
    parentGoalVersion: 4,
    memoryPolicy: 'budgeted',
    agents: [
      { agentId: 'a', status: 'running', assignedOrigin: 'https://a.test', evidenceCount: 2 },
      { agentId: 'b', status: 'queued', assignedOrigin: 'https://b.test', evidenceCount: 0 },
      { agentId: 'c', status: 'waiting_for_review', assignedOrigin: 'https://c.test', evidenceCount: 1 },
    ],
  })
  assert.equal(plan.requestedAgentCount, 3)
  assert.deepEqual(plan.agents.map((agent) => agent.agentId), ['a', 'b', 'c'])
  assert.equal(plan.agents[2].status, 'waiting_for_review')
  assert.equal(plan.agents[0].evidenceCount, 2)
  assert.equal('setRequestedAgentCount' in plan, false)
})

test('rejects duplicate or malformed child summaries instead of hiding ownership collisions', () => {
  assert.throws(() => summarizeChildPlan({ requestedAgentCount: 1, activeAgentCount: 0, queuedAgentCount: 1, parentGoalVersion: 1, memoryPolicy: 'budgeted', agents: null }), /child summaries/i)
  assert.throws(() => summarizeChildPlan({ requestedAgentCount: 2, activeAgentCount: 2, queuedAgentCount: 0, parentGoalVersion: 1, memoryPolicy: 'budgeted', agents: [
    { agentId: 'same', status: 'running', assignedOrigin: 'https://a.test', evidenceCount: 0 },
    { agentId: 'same', status: 'running', assignedOrigin: 'https://b.test', evidenceCount: 0 },
  ] }), /duplicate/i)
})

test('keeps the host subgoal label, bounded, and drops a non-string one', () => {
  const base = { requestedAgentCount: 2, activeAgentCount: 0, queuedAgentCount: 2, parentGoalVersion: 1, memoryPolicy: 'budgeted' }
  const plan = summarizeChildPlan({ ...base, agents: [
    { agentId: 'a', status: 'queued', assignedOrigin: 'https://a.test', evidenceCount: 0, subgoal: 'x'.repeat(300) },
    { agentId: 'b', status: 'queued', assignedOrigin: 'https://b.test', evidenceCount: 0, subgoal: 42 },
  ] })
  assert.equal(plan.agents[0].subgoal, 'x'.repeat(200))
  assert.equal('subgoal' in plan.agents[1], false)
})

test('keeps valid team board posts from plan members only, bounded and newest last', () => {
  const base = { requestedAgentCount: 2, activeAgentCount: 0, queuedAgentCount: 2, parentGoalVersion: 1, memoryPolicy: 'budgeted', agents: [
    { agentId: 'a', status: 'running', assignedOrigin: 'https://a.test', evidenceCount: 0, subgoal: 'Flights' },
    { agentId: 'b', status: 'running', assignedOrigin: 'https://b.test', evidenceCount: 0 },
  ] }
  assert.equal('board' in summarizeChildPlan(base), false)
  const at = '2026-10-02T00:00:00.000Z'
  const plan = summarizeChildPlan({ ...base, board: [
    { entryId: 'e1', agentId: 'a', kind: 'progress', text: 'x'.repeat(1500), at },
    { entryId: 'e2', agentId: 'zzz', kind: 'progress', text: 'alien', at },
    { entryId: 'e3', agentId: 'b', kind: 'steer', text: 'bad kind', at },
    { entryId: 'e4', agentId: 'b', kind: 'handoff', text: 'Two hotels found', at },
    'junk',
  ] })
  assert.deepEqual(plan.board.map((e) => e.entryId), ['e1', 'e4'])
  assert.equal(plan.board[0].text.length, 1000)
  assert.equal(summarizeChildPlan({ ...base, board: 'nope' }).board, undefined)
})
