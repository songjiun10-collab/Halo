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
