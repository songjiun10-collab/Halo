import { useState } from 'react'
import { LIM, agentInput, errText, type AgentApi, type AgentRecord, type Avatar as AvatarT, type TeamRecord } from './agent-api'
import { Avatar, Field, Ic, SHAPES, COLORS, Shape, Stack } from './AgentUi'
import { PLANNER_MODELS } from '../session/claude-models'

function AvatarPicker({ value, onChange }: { value: AvatarT; onChange: (a: AvatarT) => void }) {
  return <>
    <div className="hx-fld"><span className="hx-fld__top"><b>Shape</b></span><div className="hx-pick">{SHAPES.map((s) => <button type="button" key={s} aria-label={s} aria-pressed={value.shape === s} onClick={() => onChange({ ...value, shape: s })}><Shape shape={s} color={value.color} size={26} /></button>)}</div></div>
    <div className="hx-fld"><span className="hx-fld__top"><b>Color</b></span><div className="hx-pick hx-pick--c">{(Object.keys(COLORS) as AvatarT['color'][]).map((c) => <button type="button" key={c} aria-label={c} aria-pressed={value.color === c} onClick={() => onChange({ ...value, color: c })}><i style={{ background: COLORS[c] }} /></button>)}</div></div>
  </>
}
const Back = ({ onClick }: { onClick: () => void }) => <button type="button" className="hx-ag__back" onClick={onClick}><Ic d="M15 6l-6 6 6 6" />Agents</button>

export function AgentForm({ api, agent, onBack, onSaved }: { api: AgentApi; agent?: AgentRecord; onBack: () => void; onSaved: (a: AgentRecord) => void }) {
  const [f, setF] = useState({ name: agent?.name ?? '', title: agent?.title ?? '', description: agent?.description ?? '', instructions: agent?.instructions ?? '', avatar: agent?.avatar ?? { shape: 'circle', color: 'blue' } as AvatarT, model: agent?.model ?? null as string | null })
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const group = (provider: 'claude_code' | 'codex_cli') => PLANNER_MODELS.filter((m) => m.provider === provider).map((m) => <option key={m.id} value={m.id}>{m.label}{m.legacy ? ' (legacy)' : ''}</option>)
  const bad = !f.name.trim() || f.name.length > LIM.name || f.title.length > LIM.title || f.description.length > LIM.description || f.instructions.length > LIM.instructions
  const save = async () => {
    setBusy(true); setErr(null)
    try { onSaved(await api.saveAgent(agentInput(agent, f))) }
    catch (e) { setErr(errText(e)); setBusy(false) }
  }
  return <div className="hx-ag__form"><Back onClick={onBack} /><h2>{agent ? 'Edit agent' : 'New agent'}</h2>
    <div className="hx-ag__preview hx-gl"><Avatar avatar={f.avatar} size={56} /><div><b>{f.name || 'Agent name'}</b><span>{f.title || 'Title'}</span></div></div>
    <AvatarPicker value={f.avatar} onChange={set('avatar')} />
    <Field label="Name" value={f.name} onChange={set('name')} max={LIM.name} />
    <Field label="Title" value={f.title} onChange={set('title')} max={LIM.title} />
    <Field label="Description" value={f.description} onChange={set('description')} max={LIM.description} multi />
    <Field label="Role instructions" value={f.instructions} onChange={set('instructions')} max={LIM.instructions} multi rows={5} hint="How this agent should behave. It follows these on every task." />
    <div className="hx-fld"><span className="hx-fld__top"><b>Capability</b></span><span className="hx-cap"><Ic d="M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />{agent && agent.capabilityId !== 'browser' ? agent.capabilityId : 'Browser'}<small>{agent && agent.capabilityId !== 'browser' ? 'Kept from the saved agent' : 'Only capability available'}</small></span></div>
    <label className="hx-fld"><span className="hx-fld__top"><b>Model</b><small>Host default follows the model picker</small></span>
      <select className="hx-fld__in" aria-label="Agent model" value={f.model ?? ''} onChange={(e) => set('model')(e.target.value || null)}>
        <option value="">Host default</option>
        <optgroup label="Claude">{group('claude_code')}</optgroup>
        <optgroup label="Codex">{group('codex_cli')}</optgroup>
      </select></label>
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
    <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={onBack}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--p" disabled={bad || busy} onClick={save}>{agent ? 'Save changes' : 'Create agent'}</button></div></div>
}

/** Team = parent-child orchestration (members run as watch-only children). It is NOT a shared group chat. */
export function TeamForm({ api, team, agents, onBack, onSaved }: { api: AgentApi; team?: TeamRecord; agents: AgentRecord[]; onBack: () => void; onSaved: (t: TeamRecord) => void }) {
  const [f, setF] = useState({ name: team?.name ?? '', title: team?.title ?? '', description: team?.description ?? '', avatar: team?.avatar ?? { shape: 'hex', color: 'purple' } as AvatarT, ids: team?.memberAgentIds ?? [] as string[] })
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const list = agents.filter((a) => !a.archived || f.ids.includes(a.id))
  const hasArch = f.ids.some((id) => agents.find((a) => a.id === id)?.archived ?? true)
  const toggle = (id: string) => setF((x) => x.ids.includes(id) ? { ...x, ids: x.ids.filter((i) => i !== id) } : x.ids.length < LIM.members ? { ...x, ids: [...x.ids, id] } : x)
  const bad = !f.name.trim() || f.name.length > LIM.name || f.title.length > LIM.title || f.description.length > LIM.description || !f.ids.length || hasArch
  const save = async () => {
    setBusy(true); setErr(null)
    try { onSaved(await api.saveTeam({ ...(team ? { id: team.id } : {}), name: f.name.trim(), title: f.title.trim(), description: f.description.trim(), avatar: f.avatar, memberAgentIds: f.ids })) }
    catch (e) { setErr(errText(e)); setBusy(false) }
  }
  return <div className="hx-ag__form"><Back onClick={onBack} /><h2>{team ? 'Edit team' : 'New team'}</h2>
    <div className="hx-ag__preview hx-gl"><Avatar avatar={f.avatar} size={56} /><div><b>{f.name || 'Team name'}</b><span>{f.title || 'Title'}</span></div><Stack ids={f.ids} agents={agents} /></div>
    <AvatarPicker value={f.avatar} onChange={set('avatar')} />
    <Field label="Name" value={f.name} onChange={set('name')} max={LIM.name} />
    <Field label="Title" value={f.title} onChange={set('title')} max={LIM.title} />
    <Field label="Description" value={f.description} onChange={set('description')} max={LIM.description} multi />
    <div className="hx-fld"><span className="hx-fld__top"><b>Members</b><small data-over={f.ids.length === 0 || undefined}>{f.ids.length}/{LIM.members} · pick 1 to 6</small></span>
      <div className="hx-members">{list.map((a) => { const on = f.ids.includes(a.id), full = !on && f.ids.length >= LIM.members
        return <button type="button" key={a.id} className="hx-member" aria-pressed={on} disabled={full} data-archived={a.archived || undefined} onClick={() => toggle(a.id)}><Avatar avatar={a.avatar} size={32} /><span><b>{a.name}</b><small>{a.archived ? 'Archived · remove to save' : a.title}</small></span><i className="hx-tick">{on ? <Ic d="M5 12.5l4.5 4.5L19 7" s={13} /> : null}</i></button> })}</div>
      {!agents.some((a) => !a.archived) ? <em>Create an agent first.</em> : null}</div>
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
    <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={onBack}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--p" disabled={bad || busy} onClick={save}>{team ? 'Save changes' : 'Create team'}</button></div></div>
}
