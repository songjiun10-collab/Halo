import type { AgentRoster, RoomSummary } from './agent-api'
import { modelBrand } from './agent-visuals'
import type { SidebarRows, SidebarState } from './SidebarAgents'

export function sidebarRows(roster: AgentRoster, rooms: RoomSummary[], speakers: Record<string, string | null>): SidebarRows {
  const agentById = new Map(roster.agents.map((a) => [a.id, a]))
  const order = <T extends { archived: boolean; pinned: boolean }>(list: T[]) =>
    [...list].sort((p, q) => Number(p.archived) - Number(q.archived) || Number(q.pinned) - Number(p.pinned))
  const state = (archived: boolean, busy: boolean): SidebarState => archived ? 'archived' : busy ? 'working' : 'idle'
  return {
    agents: order(roster.agents).map((a) => ({
      kind: 'agent', id: a.id, name: a.name, avatar: a.avatar, brand: modelBrand(a.model), state: state(a.archived, a.status.running > 0),
      unread: a.status.hasUnread, replying: null, members: [],
    })),
    teams: order(roster.teams).map((t) => {
      const room = rooms.find((r) => r.teamId === t.id)
      const speaker = room && room.active ? speakers[room.roomId] ?? null : null
      return {
        kind: 'team', id: t.id, name: t.name, avatar: t.avatar, state: state(t.archived, t.status.running > 0 || !!room?.active),
        unread: t.status.hasUnread, replying: speaker ? agentById.get(speaker)?.name ?? null : null,
        members: t.memberAgentIds.map((id) => agentById.get(id)).filter((a): a is AgentRoster['agents'][number] => !!a),
      }
    }),
  }
}
