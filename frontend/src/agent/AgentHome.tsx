import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { LIM, errText, getAgentApi, listConversations, markRead, type AgentApi, type AgentRecord, type OwnerRef, type RosterStatus, type TeamRecord } from './agent-api'
import { rosterDot, toUi, type UiConversation } from './normalize'
import { Avatar, ConvoList, Ic, Stack } from './AgentUi'
import { AgentForm, TeamForm } from './AgentForms'
import { AgentDetail } from './AgentDetail'
import { BackgroundRuntimePanel } from './BackgroundRuntimePanel'
import { WorkspaceSections } from './WorkspacePanels'
import { onAgentView, takeAgentView } from './agent-nav'

export type HomeMode = 'task' | 'agent'
/** Task/Agent switch for the new-task home (Design System-6 glass toggle: tap or drag the thumb). Renders nothing while the preload lacks the roster API. */
export function ModeSwitch({ mode, onChange }: { mode: HomeMode; onChange: (m: HomeMode) => void }) {
  const ref = useRef<HTMLDivElement>(null), dragging = useRef(false)
  if (!getAgentApi()) return null
  const W = 84, sel = mode === 'agent' ? 1 : 0
  // No React state during the gesture: the thumb moves through a CSS variable so nothing re-renders per pointer event.
  const set = (x: number) => ref.current?.style.setProperty('--x', `${x}px`)
  const pos = (e: PointerEvent) => { const r = ref.current?.getBoundingClientRect(); return r ? Math.max(0, Math.min(W, e.clientX - r.left - 3 - W / 2)) : sel * W }
  const down = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); dragging.current = true; e.currentTarget.dataset.press = '1'; e.currentTarget.dataset.drag = '1'; set(pos(e)) }
  const move = (e: PointerEvent) => { if (dragging.current) set(pos(e)) }
  const end = (commit: boolean) => (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    delete e.currentTarget.dataset.press; delete e.currentTarget.dataset.drag
    const to = pos(e) > W / 2 ? 1 : 0
    if (commit) { set(to * W); onChange(to ? 'agent' : 'task') } else set(sel * W)
  }
  return <div className="hx-lgpos"><div ref={ref} className="hx-lg hx-gl" role="group" aria-label="Home mode" style={{ ['--x' as string]: `${sel * W}px` }} onPointerDown={down} onPointerMove={move} onPointerUp={end(true)} onPointerCancel={end(false)}>
    {(['task', 'agent'] as const).map((m) => <button type="button" key={m} className="hx-lg__b" aria-pressed={mode === m} onClick={() => onChange(m)}>{m === 'task' ? 'Task' : 'Agent'}</button>)}
    <span className="hx-lg__t" aria-hidden="true"><span className="hx-lg__s" /><span className="hx-lg__g"><span className="hx-lg__l"><span>Task</span><span>Agent</span></span></span></span>
  </div></div>
}

type View = { n: 'hub' } | { n: 'agentForm'; agent?: AgentRecord } | { n: 'teamForm'; team?: TeamRecord } | { n: 'detail'; owner: OwnerRef }

/** `onOpenTask` routes to the existing task UI (SessionStore.selectTask); no task content renders here. */
export function AgentHome({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const api = getAgentApi()
  return api ? <AgentHub api={api} onOpenTask={onOpenTask} /> : null
}

function AgentHub({ api, onOpenTask }: { api: AgentApi; onOpenTask: (taskId: string) => void }) {
  const [v, setV] = useState<View>(() => takeAgentView() ?? { n: 'hub' })
  useEffect(() => onAgentView(() => { const next = takeAgentView(); if (next) setV(next) }), [])
  const [agents, setAgents] = useState<AgentRecord[]>([]), [teams, setTeams] = useState<TeamRecord[]>([]), [convos, setConvos] = useState<UiConversation[]>([])
  const [status, setStatus] = useState<Record<string, RosterStatus>>({}), [loaded, setLoaded] = useState(false), [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      // The roster carries every record plus its status, already pinned-first.
      const roster = await api.getAgentRoster()
      const owners: OwnerRef[] = [...roster.agents.map((a) => ({ kind: 'agent' as const, id: a.id })), ...roster.teams.map((t) => ({ kind: 'team' as const, id: t.id }))]
      const rows = await Promise.all(owners.map((o) => listConversations(api, o).then((list) => list.map(toUi))))
      setAgents(roster.agents); setTeams(roster.teams)
      setStatus(Object.fromEntries([...roster.agents, ...roster.teams].map((x) => [x.id, x.status])))
      setConvos(rows.flat().sort((p, q) => +new Date(q.createdAt) - +new Date(p.createdAt))); setError(null)
    } catch (e) { setError(errText(e)) } finally { setLoaded(true) }
  }, [api])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => api.onAgentRosterEvent(() => { void refresh() }), [api, refresh])
  // Linked-task transitions reach the UI only as task events, never as roster
  // notices, so the running/attention/unread dots would go stale. Refresh once
  // (debounced) when a task's state changes, not on every action it takes.
  useEffect(() => {
    if (!api.onTaskEvent) return undefined
    const seen = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onTaskEvent((event) => {
      const key = `${event.snapshot.state}/${event.snapshot.pauseReason ?? ''}`
      if (seen.get(event.taskId) === key) return
      seen.set(event.taskId, key)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void refresh() }, 300)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [api, refresh])

  const owners = useMemo(() => Object.fromEntries([...agents, ...teams].map((x) => [x.id, x])), [agents, teams])
  const open = (owner: OwnerRef) => setV({ n: 'detail', owner })
  const openTask = (taskId: string, owner: OwnerRef) => { void markRead(api, owner).catch(() => {}); onOpenTask(taskId) }
  const find = (o: OwnerRef) => (o.kind === 'team' ? teams : agents).find((x) => x.id === o.id)
  const hub = async () => { await refresh(); setV({ n: 'hub' }) }

  let body
  if (v.n === 'agentForm') body = <AgentForm api={api} agent={v.agent} onBack={() => setV(v.agent ? { n: 'detail', owner: { kind: 'agent', id: v.agent.id } } : { n: 'hub' })} onSaved={async (a) => { await refresh(); open({ kind: 'agent', id: a.id }) }} />
  else if (v.n === 'teamForm') body = <TeamForm api={api} team={v.team} agents={agents} onBack={() => setV(v.team ? { n: 'detail', owner: { kind: 'team', id: v.team.id } } : { n: 'hub' })} onSaved={async (t) => { await refresh(); open({ kind: 'team', id: t.id }) }} />
  else if (v.n === 'detail' && find(v.owner)) {
    const owner = v.owner, it = find(owner)!
    body = <AgentDetail api={api} owner={owner} item={it} agents={agents} convos={convos.filter((c) => c.ownerId === it.id && c.kind === owner.kind)}
      onBack={hub} onEdit={() => setV(owner.kind === 'team' ? { n: 'teamForm', team: it as TeamRecord } : { n: 'agentForm', agent: it as AgentRecord })} onChanged={refresh}
      onDuplicated={async (a) => { await refresh(); open({ kind: 'agent', id: a.id }) }} onOpenTask={openTask} />
  } else {
    const nA = agents.filter((a) => !a.archived).length, nT = teams.filter((t) => !t.archived).length
    const dot = (id: string) => rosterDot(status[id])
    body = <div className="hx-ag__hub"><header className="hx-ag__hh"><h2>Agents</h2><p>Named agents with their own role. Teams run several of them under one parent task.</p></header>
      {error ? <p className="hx-ag__err" role="alert">{error}</p> : null}
      <h3 className="hx-ag__h">My agents <small>{nA}/{LIM.agents}</small></h3>
      <div className="hx-ag__grid">{agents.map((a) => <button type="button" key={a.id} className="hx-acard hx-gl" data-archived={a.archived || undefined} onClick={() => open({ kind: 'agent', id: a.id })}>
          {a.archived ? null : <i className="hx-dot" data-s={dot(a.id)} title={dot(a.id)} />}{a.pinned ? <span className="hx-pin" aria-label="Pinned"><Ic d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" s={13} /></span> : null}
          <Avatar avatar={a.avatar} size={48} /><b>{a.name}</b><span>{a.title || 'No title'}</span>{a.archived ? <i className="hx-badge">Archived</i> : null}</button>)}
        <button type="button" className="hx-acard hx-acard--new" disabled={agents.length >= LIM.agents} onClick={() => setV({ n: 'agentForm' })}><span className="hx-plus">+</span><b>New agent</b>{agents.length >= LIM.agents ? <span>Limit reached</span> : null}</button></div>
      <h3 className="hx-ag__h">Teams <small>{nT}/{LIM.teams}</small></h3>
      <div className="hx-ag__grid">{teams.map((t) => <button type="button" key={t.id} className="hx-acard hx-gl" data-archived={t.archived || undefined} onClick={() => open({ kind: 'team', id: t.id })}>
          {t.archived ? null : <i className="hx-dot" data-s={dot(t.id)} title={dot(t.id)} />}{t.pinned ? <span className="hx-pin" aria-label="Pinned"><Ic d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" s={13} /></span> : null}
          <Stack ids={t.memberAgentIds} agents={agents} /><b>{t.name}</b><span>{t.memberAgentIds.length} members</span>{t.archived ? <i className="hx-badge">Archived</i> : null}</button>)}
        <button type="button" className="hx-acard hx-acard--new" disabled={teams.length >= LIM.teams || !agents.some((a) => !a.archived)} onClick={() => setV({ n: 'teamForm' })}><span className="hx-plus">+</span><b>New team</b>{teams.length >= LIM.teams ? <span>Limit reached</span> : null}</button></div>
      <h3 className="hx-ag__h">Recent conversations</h3>
      {loaded ? <ConvoList rows={convos.slice(0, 8)} owners={owners} showOwner onOpen={(c) => openTask(c.taskId, { kind: c.kind, id: c.ownerId })} /> : <p className="hx-ag__empty">Loading…</p>}
      <h3 className="hx-ag__h">Background service</h3>
      <BackgroundRuntimePanel />
      <WorkspaceSections onOpenTask={onOpenTask} /></div>
  }
  return <div className="hx-ag">{body}</div>
}
