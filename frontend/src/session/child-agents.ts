export type ChildAgentStatus = 'queued' | 'running' | 'waiting_for_review' | 'paused' | 'completed' | 'failed' | 'uncertain' | 'stopped'
export interface ChildAgentSummary {
  agentId: string
  status: ChildAgentStatus
  assignedOrigin: string
  evidenceCount: number
  reason?: string
}
export interface ChildPlanSummary {
  requestedAgentCount: number
  activeAgentCount: number
  queuedAgentCount: number
  parentGoalVersion: number
  memoryPolicy: 'budgeted' | 'user_override'
  agents: ChildAgentSummary[]
}

const statuses = new Set<ChildAgentStatus>(['queued', 'running', 'waiting_for_review', 'paused', 'completed', 'failed', 'uncertain', 'stopped'])

/** Validate and project host-owned child summaries; the renderer never edits the proposed count. */
export function summarizeChildPlan(input: ChildPlanSummary): ChildPlanSummary {
  if (!Array.isArray(input.agents)) throw new Error('invalid child summaries')
  if (!Number.isSafeInteger(input.requestedAgentCount) || input.requestedAgentCount < 1 || input.requestedAgentCount !== input.agents.length) throw new Error('invalid child count')
  if (!Number.isSafeInteger(input.parentGoalVersion) || input.parentGoalVersion < 1) throw new Error('invalid parent goal version')
  if (input.memoryPolicy !== 'budgeted' && input.memoryPolicy !== 'user_override') throw new Error('invalid memory policy')
  const seen = new Set<string>()
  const agents = input.agents.map((agent) => {
    if (typeof agent.agentId !== 'string' || !agent.agentId || seen.has(agent.agentId)) throw new Error('duplicate or invalid child identity')
    seen.add(agent.agentId)
    if (!statuses.has(agent.status)) throw new Error('invalid child status')
    let origin: URL
    try { origin = new URL(agent.assignedOrigin) } catch { throw new Error('invalid child origin') }
    if (!/^https?:$/.test(origin.protocol) || origin.origin !== agent.assignedOrigin || origin.username || origin.password) throw new Error('invalid child origin')
    if (!Number.isSafeInteger(agent.evidenceCount) || agent.evidenceCount < 0) throw new Error('invalid evidence count')
    return { agentId: agent.agentId, status: agent.status, assignedOrigin: origin.origin, evidenceCount: agent.evidenceCount, ...(agent.reason ? { reason: String(agent.reason).slice(0, 500) } : {}) }
  })
  if (!Number.isSafeInteger(input.activeAgentCount) || !Number.isSafeInteger(input.queuedAgentCount) || input.activeAgentCount < 0 || input.queuedAgentCount < 0 || input.activeAgentCount + input.queuedAgentCount > input.requestedAgentCount) throw new Error('invalid active child counts')
  return { requestedAgentCount: input.requestedAgentCount, activeAgentCount: input.activeAgentCount, queuedAgentCount: input.queuedAgentCount, parentGoalVersion: input.parentGoalVersion, memoryPolicy: input.memoryPolicy, agents }
}
