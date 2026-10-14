import type { AgentRecord } from './agent-api'

export const activeAgentCount = (agents: AgentRecord[]) => agents.filter((agent) => !agent.archived).length
