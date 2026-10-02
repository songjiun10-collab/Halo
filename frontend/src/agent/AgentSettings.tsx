import { useCallback, useEffect, useState } from 'react'
import { DAY_NAMES, LIM, blankSchedule, errText, fromLocalInput, saveMcpScope, scheduleInput, scheduleLabel, schedulesFor, switchTrigger, toLocalInput, triggerProblem, type AgentApi, type AgentRecord, type McpProvider, type OwnerRef, type ScheduleInput, type ScheduleRecord, type ScheduleTrigger } from './agent-api'
import { Ic } from './AgentUi'
import { useBackgroundRuntime } from './BackgroundRuntimePanel'

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const ZONES = ['Asia/Seoul', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'UTC']
const MAX_MINUTES = 366 * 24 * 60

/** Stored on the agent: null = everything the host enables, an array narrows it. */
export function McpScope({ api, agent, onSaved }: { api: AgentApi; agent: AgentRecord; onSaved: () => void }) {
  const [providers, setProviders] = useState<McpProvider[]>([])
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api.listMcpProviders().then(setProviders).catch((e) => setErr(errText(e))) }, [api])
  const selected = agent.mcpProviders ?? providers.filter((p) => p.enabled).map((p) => p.id)
  const save = async (next: string[] | null) => { setErr(null); try { await saveMcpScope(api, agent, next); onSaved() } catch (e) { setErr(errText(e)) } }
  const toggle = (id: string) => void save(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    <ul className="hx-xlist">{providers.map((m) => { const on = selected.includes(m.id)
      return <li key={m.id}><button type="button" className="hx-xitem hx-gl" aria-pressed={on} disabled={!m.enabled} onClick={() => toggle(m.id)}>
        <i className="hx-tick">{on ? <Ic d="M5 12.5l4.5 4.5L19 7" s={13} /> : null}</i><span className="hx-xitem__t"><b>{m.label}</b><small>{m.enabled ? (on ? 'Allowed for this agent' : 'Not used by this agent') : 'Turned off for this workspace'}</small></span></button></li> })}</ul>
    {agent.mcpProviders !== null ? <button type="button" className="hx-link" onClick={() => void save(null)}>Use the workspace setting</button> : null}
    <p className="hx-ag__note">An agent can only narrow what the workspace allows. A team uses its members' tools combined.</p>
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
  </div>
}

const KINDS: [ScheduleTrigger['kind'], string][] = [['calendar', 'Days'], ['interval', 'Every'], ['once', 'Once']]

/** Edits every trigger kind the host accepts (calendar, interval, once). */
export function ScheduleEditor({ initial, error, onSave, onCancel }: { initial: ScheduleInput; error: string | null; onSave: (s: ScheduleInput) => void; onCancel: () => void }) {
  const [s, setS] = useState(initial)
  const trig = s.trigger
  const setTrig = (next: ScheduleTrigger) => setS((v) => ({ ...v, trigger: next }))
  const problem = triggerProblem(trig)
  const bad = !!problem || !s.request.trim() || s.request.length > LIM.request
  let when
  if (trig.kind === 'calendar') {
    const tog = (d: number) => setTrig({ ...trig, days: trig.days.includes(d) ? trig.days.filter((x) => x !== d) : [...trig.days, d].sort((a, b) => a - b) })
    const zones = ZONES.includes(trig.timeZone) ? ZONES : [trig.timeZone, ...ZONES]
    when = <><div className="hx-xday" role="group" aria-label="Days">{DAY_NAMES.map((n, i) => <button type="button" key={n} aria-pressed={trig.days.includes(i + 1)} onClick={() => tog(i + 1)}>{n}</button>)}</div>
      <div className="hx-sched__g hx-xcols">
        <label>Time<input type="time" value={trig.time} onChange={(e) => setTrig({ ...trig, time: e.target.value })} /></label>
        <label>Time zone<select value={trig.timeZone} onChange={(e) => setTrig({ ...trig, timeZone: e.target.value })}>{zones.map((z) => <option key={z}>{z}</option>)}</select></label></div></>
  } else if (trig.kind === 'interval') {
    when = <div className="hx-sched__g"><label>Repeat every (minutes)<input type="number" min={1} max={MAX_MINUTES} value={Math.round(trig.everyMs / 60_000)}
      onChange={(e) => setTrig({ ...trig, everyMs: Math.max(1, Math.min(MAX_MINUTES, Math.trunc(+e.target.value) || 1)) * 60_000 })} /></label></div>
  } else {
    when = <div className="hx-sched__g"><label>Run at<input type="datetime-local" value={toLocalInput(trig.at)}
      onChange={(e) => { const at = fromLocalInput(e.target.value); if (at) setTrig({ ...trig, at }) }} /></label></div>
  }
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    <label className="hx-fld"><span className="hx-fld__top"><b>Task</b><small data-over={s.request.length > LIM.request || undefined}>{s.request.length}/{LIM.request}</small></span>
      <textarea className="hx-fld__in" rows={2} value={s.request} placeholder="What should run each time?" onChange={(e) => setS({ ...s, request: e.target.value })} /></label>
    <div className="hx-xseg" role="radiogroup" aria-label="Repeat">{KINDS.map(([k, label]) =>
      <button type="button" key={k} role="radio" aria-checked={trig.kind === k} onClick={() => { if (trig.kind !== k) setTrig(switchTrigger(k, trig.kind === 'calendar' ? trig.timeZone : localZone())) }}>{label}</button>)}</div>
    {when}
    {problem ? <p className="hx-ag__note">{problem}</p> : null}
    <div className="hx-sched__g">
      <label>When approval is needed<select value={s.onApproval} onChange={(e) => setS({ ...s, onApproval: e.target.value as ScheduleInput['onApproval'] })}><option value="pause">Pause and wait for me</option><option value="deny">Deny and continue</option></select></label>
      <label>Planner calls per run<input type="number" min={1} max={LIM.plannerCalls} value={s.maxPlannerCalls} onChange={(e) => setS({ ...s, maxPlannerCalls: Math.max(1, Math.min(LIM.plannerCalls, Math.trunc(+e.target.value) || 1)) })} /></label></div>
    <p className="hx-ag__note">{s.onApproval === 'pause' ? 'A paused run waits in your conversations until you approve or stop it.' : 'Steps that need approval are denied. The run continues without them.'}</p>
    {error ? <p className="hx-ag__err" role="alert">{error}</p> : null}
    <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={onCancel}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--p" disabled={bad} onClick={() => onSave(s)}>Save schedule</button></div></div>
}

/** Always-on runs fire only from the background service, so its state sits next to the list. */
export function ScheduleSection({ api, owner }: { api: AgentApi; owner: OwnerRef }) {
  const [list, setList] = useState<ScheduleRecord[]>([]), [edit, setEdit] = useState<ScheduleInput | null>(null), [err, setErr] = useState<string | null>(null)
  const { state } = useBackgroundRuntime()
  const { kind, id } = owner
  const load = useCallback(() => api.listAgentSchedules().then((all) => setList(schedulesFor(all, { kind, id }))).catch((e) => setErr(errText(e))), [api, kind, id])
  useEffect(() => { void load() }, [load])
  useEffect(() => api.onAgentRosterEvent((n) => { if (n.id === id && n.change.startsWith('schedule_')) void load() }), [api, id, load])
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); setEdit(null); await load() } catch (e) { setErr(errText(e)) } }
  const live = state.connection === 'connected' && state.service === 'running'
  return <>
    <h3 className="hx-ag__h">Always-on schedule</h3>
    <p className="hx-ag__note hx-ag__note--eye"><span className="hx-xlive" data-on={live || undefined} /><span>{live ? 'Background service connected. Schedules run on time.' : "Background service not connected from this window. Schedules run only while it's running."}</span></p>
    {edit ? <ScheduleEditor initial={edit} error={err} onSave={(s) => void run(() => api.saveAgentSchedule(scheduleInput(s)))} onCancel={() => { setEdit(null); setErr(null) }} /> : <>
      {list.map((s) => <div className="hx-xrow hx-gl" key={s.id}><div className="hx-xrow__b"><b>{scheduleLabel(s.trigger)}{s.enabled ? '' : ' · off'}</b>
        <small>{`${s.request} · ${s.trigger.kind === 'calendar' ? `${s.trigger.timeZone} · ` : ''}${s.onApproval === 'pause' ? 'Pauses for approval' : 'Denies approval'} · ${s.maxPlannerCalls} planner calls${s.disabledReason ? ` · stopped: ${s.disabledReason}` : ''}`}</small></div>
        <button type="button" className="hx-agbtn" onClick={() => setEdit(scheduleInput(s))}>Edit</button>
        <button type="button" className="hx-agbtn" aria-pressed={s.enabled} onClick={() => void run(() => api.saveAgentSchedule({ ...scheduleInput(s), enabled: !s.enabled }))}>{s.enabled ? 'Turn off' : 'Turn on'}</button>
        <button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => void run(() => api.deleteAgentSchedule(s.id))}>Delete</button></div>)}
      {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
      <button type="button" className="hx-agbtn" style={{ alignSelf: 'flex-start' }} onClick={() => setEdit(blankSchedule(owner, localZone()))}>+ Add schedule</button></>}
  </>
}
