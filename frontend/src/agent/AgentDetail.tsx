import { useState } from 'react'
import { errText, errorCopy, getRoomApi, setPinned, startTask, type AgentApi, type AgentRecord, type OwnerRef, type TeamRecord } from './agent-api'
import { Avatar, ConvoList, Ic } from './AgentUi'
import { McpScope, ScheduleSection } from './AgentSettings'
import { TeamRoom } from './Room'
import type { UiConversation } from './normalize'

interface Props {
  api: AgentApi; owner: OwnerRef; item: AgentRecord | TeamRecord; agents: AgentRecord[]; convos: UiConversation[]
  onBack: () => void; onEdit: () => void; onChanged: () => Promise<void>; onDuplicated: (a: AgentRecord) => void; onOpenTask: (taskId: string, owner: OwnerRef) => void
}

/** A Team is parent-child orchestration (members run as watch-only children), not a shared chat. */
export function AgentDetail({ api, owner, item, agents, convos, onBack, onEdit, onChanged, onDuplicated, onOpenTask }: Props) {
  const [req, setReq] = useState(''), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false)
  const isTeam = owner.kind === 'team'
  const roomApi = isTeam ? getRoomApi() : null
  const members = isTeam ? (item as TeamRecord).memberAgentIds.map((i) => agents.find((a) => a.id === i)) : []
  const memberGone = members.some((m) => !m || m.archived), blocked = item.archived || memberGone
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn() } catch (e) { setErr(errText(e)) } }
  const start = async () => {
    if (blocked || busy || !req.trim()) return
    setBusy(true)
    await run(async () => { const r = await startTask(api, owner, req); setReq(''); onOpenTask(r.taskId, owner) })
    setBusy(false)
  }
  const archive = () => run(async () => { await (isTeam ? api.archiveTeam(item.id) : api.archiveAgent(item.id)); setConfirm(false); await onChanged() })
  return <div className="hx-ag__form hx-ag__detail"><button type="button" className="hx-ag__back" onClick={onBack}><Ic d="M15 6l-6 6 6 6" />Agents</button>
    <header className="hx-ag__dh"><Avatar avatar={item.avatar} size={64} /><div><h2>{item.name}{item.archived ? <span className="hx-badge">Archived</span> : null}</h2><p>{item.title}</p></div>
      {!item.archived ? <div className="hx-ag__dact">
        <button type="button" className="hx-agbtn" aria-pressed={item.pinned} onClick={() => run(async () => { await setPinned(api, owner, !item.pinned); await onChanged() })}>{item.pinned ? 'Unpin' : 'Pin'}</button>
        {!isTeam ? <button type="button" className="hx-agbtn" onClick={() => run(async () => onDuplicated(await api.duplicateAgent(item.id)))}>Duplicate</button> : null}
        <button type="button" className="hx-agbtn" onClick={onEdit}>Edit</button>
        {confirm ? <><button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => void archive()}>Archive</button><button type="button" className="hx-agbtn" onClick={() => setConfirm(false)}>Keep</button></> : <button type="button" className="hx-agbtn" onClick={() => setConfirm(true)}>Archive…</button>}
      </div> : null}</header>
    {confirm ? <p className="hx-ag__note">Archiving stops new tasks and schedules. Past conversations stay viewable. You can't edit it afterwards.</p> : null}
    {item.description ? <p className="hx-ag__desc">{item.description}</p> : null}
    {isTeam ? <><div className="hx-ag__members">{members.map((m, i) => m
      ? <span key={m.id} className="hx-chipm" data-archived={m.archived || undefined}><Avatar avatar={m.avatar} size={22} />{m.name}{m.archived ? ' · archived' : ''}</span>
      : <span key={`gone-${i}`} className="hx-chipm" data-archived>Removed agent</span>)}</div>
      <p className="hx-ag__note hx-ag__note--eye"><Ic d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z" /><span>Team subtasks are watch-only. You can view and scroll them; members don't click or type for you.</span></p></> : null}
    <div className="hx-ag__start"><input className="hx-fld__in hx-ag__ask" value={req} disabled={blocked} aria-label={`Task for ${item.name}`} placeholder={blocked ? 'Starting is unavailable' : `What should ${item.name} do?`} onChange={(e) => setReq(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void start() }} />
      <button type="button" className="hx-agbtn hx-agbtn--p" disabled={blocked || busy || !req.trim()} onClick={() => void start()}>Start</button></div>
    {item.archived ? <p className="hx-ag__err">{errorCopy('agent_unavailable')}</p> : memberGone ? <p className="hx-ag__err">{errorCopy('team_member_unavailable')} <button type="button" className="hx-link" onClick={onEdit}>Edit team</button></p> : null}
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
    {roomApi ? <><h3 className="hx-ag__h">Team room</h3><TeamRoom api={roomApi} teamId={item.id} agents={agents} archived={item.archived} onOpenTask={(taskId) => onOpenTask(taskId, owner)} /></> : null}
    {!isTeam && !item.archived ? <><h3 className="hx-ag__h">Tools <small>MCP · can only narrow the workspace set</small></h3><McpScope api={api} agent={item as AgentRecord} onSaved={() => void onChanged()} /></> : null}
    {!item.archived ? <ScheduleSection api={api} owner={owner} /> : null}
    <h3 className="hx-ag__h">Conversations</h3>
    <ConvoList rows={convos} owners={{ [item.id]: item }} onOpen={(c) => onOpenTask(c.taskId, owner)} />
  </div>
}
