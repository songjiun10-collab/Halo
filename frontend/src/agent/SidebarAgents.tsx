import { useCallback, useEffect, useState } from 'react'
import { getAgentApi, getRoomApi, type AgentRecord, type AgentRoster, type OwnerKind, type OwnerRef, type RoomSummary } from './agent-api'
import { Avatar } from './AgentUi'

/**
 * Agents and Teams under the workspace sidebar's task list. A row only opens the
 * agent detail or the team room: it never starts or resumes a task.
 */
export const SIDEBAR_MAX = 5

export type SidebarState = 'working' | 'idle' | 'archived'
export interface SidebarRow { kind: OwnerKind; id: string; name: string; avatar: AgentRecord['avatar']; state: SidebarState; unread: boolean; replying: string | null; members: AgentRecord[] }
export interface SidebarRows { agents: SidebarRow[]; teams: SidebarRow[] }

/** `speakers` maps a room id to the member id whose turn it is in a live round. */
export function sidebarRows(roster: AgentRoster, rooms: RoomSummary[], speakers: Record<string, string | null>): SidebarRows {
  const agentById = new Map(roster.agents.map((a) => [a.id, a]))
  const order = <T extends { archived: boolean; pinned: boolean }>(list: T[]) =>
    [...list].sort((p, q) => Number(p.archived) - Number(q.archived) || Number(q.pinned) - Number(p.pinned))
  const state = (archived: boolean, busy: boolean): SidebarState => archived ? 'archived' : busy ? 'working' : 'idle'
  return {
    agents: order(roster.agents).map((a) => ({
      kind: 'agent', id: a.id, name: a.name, avatar: a.avatar, state: state(a.archived, a.status.running > 0),
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

function Row({ row, onOpen }: { row: SidebarRow; onOpen: () => void }) {
  return (
    <button type="button" className="hx-sbr" data-owner={`${row.kind}:${row.id}`} data-archived={row.state === 'archived' || undefined} title={row.name} onClick={onOpen}>
      {row.kind === 'team'
        ? <span className="hx-sbr__stack">{row.members.slice(0, 3).map((a, i) => <span key={a.id} style={{ marginLeft: i ? -7 : 0, zIndex: 5 - i }}><Avatar avatar={a.avatar} size={16} ring /></span>)}</span>
        : <span className="hx-sbr__av"><Avatar avatar={row.avatar} size={20} /></span>}
      <span className="hx-sbr__n">{row.name}</span>
      {row.replying ? <span className="hx-typing" role="status" aria-label={`${row.replying} is replying`}><i /><i /><i /></span> : null}
      {row.unread && row.state !== 'archived' ? <span className="hx-sbr__badge" aria-label="Unread" /> : null}
      <i className="hx-sbr__st" data-s={row.state} aria-label={row.state} />
    </button>
  )
}

interface ViewProps { rows: SidebarRows; loaded: boolean; onOpen: (owner: OwnerRef) => void; onSeeAll: () => void; onNew: () => void }

export function SidebarAgentsView({ rows, loaded, onOpen, onSeeAll, onNew }: ViewProps) {
  const section = (title: string, kind: OwnerKind, list: SidebarRow[]) => (
    <div className="hx-sidebar__section">
      <p className="hx-sidebar__label hx-sbr__label">{title}<button type="button" className="hx-sbr__add" aria-label={kind === 'agent' ? 'New agent' : 'New team'} onClick={onNew}>+</button></p>
      {loaded && !list.length ? <p className="hx-sidebar__empty">No {kind}s yet · Create one in Agent tab</p> : null}
      {list.slice(0, SIDEBAR_MAX).map((row) => <Row key={row.id} row={row} onOpen={() => onOpen({ kind: row.kind, id: row.id })} />)}
      {list.length > SIDEBAR_MAX ? <button type="button" className="hx-sbr hx-sbr__all" onClick={onSeeAll}>See all {list.length}</button> : null}
    </div>
  )
  return <>{section('Agents', 'agent', rows.agents)}{section('Teams', 'team', rows.teams)}</>
}

/** Renders nothing outside the desktop app (no agent bridge). */
export function SidebarAgents({ onOpen, onSeeAll, onNew }: { onOpen: (owner: OwnerRef) => void; onSeeAll: () => void; onNew: () => void }) {
  const api = getAgentApi(), roomApi = getRoomApi()
  const [roster, setRoster] = useState<AgentRoster | null>(null)
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [speakers, setSpeakers] = useState<Record<string, string | null>>({})
  const load = useCallback(async () => {
    if (!api) return
    try {
      const [nextRoster, nextRooms] = await Promise.all([api.getAgentRoster(), roomApi ? roomApi.listRooms() : Promise.resolve([])])
      setRoster(nextRoster); setRooms(nextRooms)
    } catch { /* the sidebar never takes the shell down; the Agent tab shows the error */ }
  }, [api, roomApi])
  useEffect(() => {
    if (!api) return undefined
    void load()
    const offRoster = api.onAgentRosterEvent(() => { void load() })
    const offRoom = roomApi?.onRoomEvent((event) => {
      if ('round' in event) {
        setSpeakers((s) => ({ ...s, [event.roomId]: event.round.active ? event.round.speakerId : null }))
        void load()
      }
    })
    return () => { offRoster(); offRoom?.() }
  }, [api, roomApi, load])
  if (!api) return null
  const open = (owner: OwnerRef) => {
    if (owner.kind === 'team') void api.markAgentConversationsRead({ teamId: owner.id }).catch(() => {})
    onOpen(owner)
  }
  return <SidebarAgentsView rows={roster ? sidebarRows(roster, rooms, speakers) : { agents: [], teams: [] }} loaded={!!roster} onOpen={open} onSeeAll={onSeeAll} onNew={onNew} />
}
