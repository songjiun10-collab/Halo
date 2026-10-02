import { useCallback, useEffect, useState } from 'react'
import { errText } from './agent-api'
import {
  MEMORY_LIMIT, blankRoutine, blankStep, canMemory, canRoutines, canUsage, formatTokens, formatUsd, limitPatch, routineDraft, routineInput, routineProblem, usageRows, workspaceApi,
  type MemoryEntry, type RoutineDraft, type RoutineRecord, type StepDraft, type UsageProvider, type UsageRow, type UsageSummary, type WorkspaceApi,
} from './workspace-api'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null)

function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value * 10) / 10))
  return <span className="hx-meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} data-high={v >= 80 || undefined}><i style={{ width: `${v}%` }} /></span>
}

function LimitEditor({ row, onSave, onCancel }: { row: UsageRow; onSave: (patch: { tokens: number | null; costUsd: number | null }) => void; onCancel: () => void }) {
  const [tokens, setTokens] = useState(row.limit.tokens === null ? '' : String(row.limit.tokens))
  const [cost, setCost] = useState(row.limit.costUsd === null ? '' : String(row.limit.costUsd))
  const [err, setErr] = useState<string | null>(null)
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    <div className="hx-sched__g hx-xcols">
      <label>Token limit<input inputMode="numeric" aria-label={`${row.label} token limit`} placeholder="No limit" value={tokens} onChange={(e) => setTokens(e.target.value)} /></label>
      <label>Cost limit (USD)<input inputMode="decimal" aria-label={`${row.label} cost limit`} placeholder="No limit" value={cost} onChange={(e) => setCost(e.target.value)} /></label></div>
    <p className="hx-ag__note">New tasks on {row.label} stop being admitted once either limit is reached. Leave a field blank for no limit.</p>
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
    <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={onCancel}>Cancel</button>
      <button type="button" className="hx-agbtn hx-agbtn--p" onClick={() => { try { onSave(limitPatch(tokens, cost)) } catch (e) { setErr((e as Error).message) } }}>Save limit</button></div></div>
}

export function UsageView({ usage, busy, onSync, onSaveLimit, editing: initialEdit = null }: { usage: UsageSummary; busy: boolean; onSync: () => void; onSaveLimit: (provider: UsageProvider, patch: { tokens: number | null; costUsd: number | null }) => void; editing?: UsageProvider | null }) {
  const [editing, setEditing] = useState<UsageProvider | null>(initialEdit)
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    {usageRows(usage).map((r) => {
      const limits = [r.limit.tokens !== null ? `${formatTokens(r.limit.tokens)} tokens` : null, r.limit.costUsd !== null ? formatUsd(r.limit.costUsd) : null].filter(Boolean).join(' · ')
      return <div key={r.provider} className="hx-xrow hx-gl hx-usage"><div className="hx-xrow__b">
        <b>{r.label} <span className="hx-usage__n">{formatTokens(r.tokens)} tokens · {formatUsd(r.costUsd)}</span>{r.exceeded ? <i className="hx-badge" data-warn="">Limit reached</i> : null}</b>
        <small>{r.basis === 'imported' ? `From the ${r.label} CLI${r.sessions ? ` · ${r.sessions} sessions` : ''}` : 'Counted by HALO tasks'}{limits ? ` · limit ${limits}` : ' · no limit'}</small>
        {r.usedRatio !== null ? <Meter value={r.usedRatio * 100} label={`${r.label} limit used`} /> : null}
        {r.windows.map((w) => <div className="hx-usage__w" key={w.label}><span>{w.label}</span><Meter value={w.usedPercent} label={`${r.label} ${w.label}`} /><span>{Math.round(w.usedPercent)}%{w.resetsAt ? ` · resets ${when(w.resetsAt)}` : ''}</span></div>)}
        {editing === r.provider ? <LimitEditor row={r} onCancel={() => setEditing(null)} onSave={(patch) => { setEditing(null); onSaveLimit(r.provider, patch) }} /> : null}
      </div>{editing === r.provider ? null : <button type="button" className="hx-agbtn" onClick={() => setEditing(r.provider)}>Set limit</button>}</div>
    })}
    <div className="hx-ag__actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="hx-agbtn" disabled={busy} onClick={onSync}>{busy ? 'Syncing…' : 'Sync from CLIs'}</button></div>
  </div>
}

const SYNC_COPY: Record<string, string> = { synced: 'synced', no_records: 'no local records', not_configured: 'not set up', failed: 'could not be read' }
const syncSummary = (results: Record<string, { status: string; sessions?: number }>) =>
  Object.entries(results).map(([k, v]) => `${k === 'claudeSubscription' ? 'Claude plan' : k === 'codex' ? 'Codex' : 'Claude'}: ${SYNC_COPY[v.status] ?? v.status}`).join(' · ')

export function UsagePanel({ api }: { api: WorkspaceApi }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null), [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null), [note, setNote] = useState<string | null>(null)
  useEffect(() => { api.getUsage().then(setUsage).catch((e) => setErr(errText(e))) }, [api])
  const sync = async () => { setBusy(true); setErr(null); try { const r = await api.syncUsage(); setUsage(r.usage); setNote(syncSummary(r.results)) } catch (e) { setErr(errText(e)) } finally { setBusy(false) } }
  const saveLimit = async (p: UsageProvider, patch: { tokens: number | null; costUsd: number | null }) => { setErr(null); try { setUsage(await api.setUsageLimit(p, patch)) } catch (e) { setErr(errText(e)) } }
  return <>
    {usage ? <UsageView usage={usage} busy={busy} onSync={() => void sync()} onSaveLimit={(p, patch) => void saveLimit(p, patch)} /> : err ? null : <p className="hx-ag__empty">Loading…</p>}
    {note ? <p className="hx-ag__note">{note}</p> : null}
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
  </>
}

export function MemoryView({ memories, onSave, onRemove }: { memories: MemoryEntry[]; onSave: (input: { id?: string; text: string }) => void; onRemove: (id: string) => void }) {
  const [draft, setDraft] = useState(''), [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const full = memories.length >= MEMORY_LIMIT
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    {memories.map((m) => edit?.id === m.id
      ? <div key={m.id} className="hx-ag__form" style={{ width: '100%' }}><textarea className="hx-fld__in" rows={2} aria-label="Edit memory" value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
        <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--p" disabled={!edit.text.trim()} onClick={() => { onSave({ id: m.id, text: edit.text }); setEdit(null) }}>Save</button></div></div>
      : <div key={m.id} className="hx-xrow hx-gl"><div className="hx-xrow__b"><b className="hx-wrap">{m.text}</b><small>{m.origin ? `Only on ${m.origin}` : 'Every site'}</small></div>
        <button type="button" className="hx-agbtn" onClick={() => setEdit({ id: m.id, text: m.text })}>Edit</button>
        <button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => onRemove(m.id)}>Delete</button></div>)}
    {memories.length === 0 ? <p className="hx-ag__empty">No memories yet. Planners see what you save here at the start of every task.</p> : null}
    <label className="hx-fld"><span className="hx-fld__top"><b>Add a memory</b><small data-over={full || undefined}>{memories.length}/{MEMORY_LIMIT}</small></span>
      <textarea className="hx-fld__in" rows={2} aria-label="New memory" placeholder="Something every task should know, e.g. preferred language or accounts to use" value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
    <div className="hx-ag__actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="hx-agbtn hx-agbtn--p" disabled={full || !draft.trim()} onClick={() => { onSave({ text: draft }); setDraft('') }}>Save memory</button></div>
  </div>
}

export function MemoryPanel({ api }: { api: WorkspaceApi }) {
  const [list, setList] = useState<MemoryEntry[] | null>(null), [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => api.listMemories().then((l) => { setList(l); setErr(null) }).catch((e) => setErr(errText(e))), [api])
  useEffect(() => { void load() }, [load])
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); await load() } catch (e) { setErr(errText(e)) } }
  return <>
    {list ? <MemoryView memories={list} onSave={(input) => void run(() => api.saveMemory(input))} onRemove={(id) => void run(() => api.removeMemory(id))} /> : err ? null : <p className="hx-ag__empty">Loading…</p>}
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
  </>
}

const STEP_KINDS: [StepDraft['kind'], string][] = [['navigate', 'Navigate'], ['follow_link', 'Follow link'], ['scroll', 'Scroll']]
const stepCount = (n: number) => `${n} step${n === 1 ? '' : 's'}`

export function RoutineList({ routines, onRun, onEdit, onDelete, onNew }: { routines: RoutineRecord[]; onRun: (r: RoutineRecord) => void; onEdit: (r: RoutineRecord) => void; onDelete: (r: RoutineRecord) => void; onNew: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    {routines.map((r) => <div key={r.routineId} className="hx-xrow hx-gl"><div className="hx-xrow__b"><b>{r.name}</b>
      <small>{`${stepCount(r.steps.length)} · v${r.revision} · ${r.origins.join(', ')}`}{r.description ? ` · ${r.description}` : ''}</small></div>
      {confirm === r.routineId ? <>
        <button type="button" className="hx-agbtn" onClick={() => setConfirm(null)}>Keep</button>
        <button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => { setConfirm(null); onDelete(r) }}>Delete routine</button></> : <>
        <button type="button" className="hx-agbtn hx-agbtn--p" onClick={() => onRun(r)}>Run</button>
        <button type="button" className="hx-agbtn" onClick={() => onEdit(r)}>Edit</button>
        <button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => setConfirm(r.routineId)}>Delete</button></>}</div>)}
    {routines.length === 0 ? <p className="hx-ag__empty">No routines yet. A routine replays fixed steps on the sites you list, then asks you to confirm it finished.</p> : null}
    <button type="button" className="hx-agbtn" style={{ alignSelf: 'flex-start' }} onClick={onNew}>+ New routine</button>
  </div>
}

function StepFields({ step, n, set }: { step: StepDraft; n: number; set: (s: StepDraft) => void }) {
  if (step.kind === 'navigate') return <label>URL<input aria-label={`Step ${n} URL`} placeholder="https://example.com/page" value={step.url} onChange={(e) => set({ ...step, url: e.target.value })} /></label>
  if (step.kind === 'follow_link') return <>
    <label>Link text<input aria-label={`Step ${n} link text`} placeholder="Exact visible text" value={step.name} onChange={(e) => set({ ...step, name: e.target.value })} /></label>
    <label>Expected URL (optional)<input aria-label={`Step ${n} expected URL`} value={step.expectedHref} onChange={(e) => set({ ...step, expectedHref: e.target.value })} /></label></>
  return <>
    <label>Direction<select aria-label={`Step ${n} direction`} value={step.direction} onChange={(e) => set({ ...step, direction: e.target.value as 'up' | 'down' })}><option value="down">Down</option><option value="up">Up</option></select></label>
    <label>Pixels (optional)<input inputMode="numeric" aria-label={`Step ${n} pixels`} placeholder="One screen" value={step.amount} onChange={(e) => set({ ...step, amount: e.target.value })} /></label></>
}

export function RoutineEditor({ initial, error, onSave, onCancel }: { initial: RoutineDraft; error: string | null; onSave: (d: RoutineDraft) => void; onCancel: () => void }) {
  const [d, setD] = useState(initial)
  const problem = routineProblem(d)
  const setStep = (i: number, s: StepDraft) => setD({ ...d, steps: d.steps.map((x, j) => (j === i ? s : x)) })
  const move = (i: number, by: number) => { const steps = [...d.steps]; const [s] = steps.splice(i, 1); steps.splice(i + by, 0, s); setD({ ...d, steps }) }
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    <label className="hx-fld"><span className="hx-fld__top"><b>Name</b></span><input className="hx-fld__in" aria-label="Routine name" maxLength={256} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
    <label className="hx-fld"><span className="hx-fld__top"><b>Description</b><small>Optional</small></span><input className="hx-fld__in" aria-label="Routine description" maxLength={2000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
    {d.steps.map((s, i) => <div key={i} className="hx-xrow hx-gl hx-step"><div className="hx-xrow__b">
      <b>Step {i + 1}</b>
      <div className="hx-xseg" role="radiogroup" aria-label={`Step ${i + 1} kind`}>{STEP_KINDS.map(([k, label]) => <button type="button" key={k} role="radio" aria-checked={s.kind === k} onClick={() => { if (s.kind !== k) setStep(i, blankStep(k)) }}>{label}</button>)}</div>
      <div className="hx-sched__g"><StepFields step={s} n={i + 1} set={(next) => setStep(i, next)} /></div></div>
      <div className="hx-step__tools">
        <button type="button" className="hx-agbtn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
        <button type="button" className="hx-agbtn" aria-label={`Move step ${i + 1} down`} disabled={i === d.steps.length - 1} onClick={() => move(i, 1)}>↓</button>
        <button type="button" className="hx-agbtn hx-agbtn--d" aria-label={`Remove step ${i + 1}`} disabled={d.steps.length === 1} onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}>×</button></div></div>)}
    <button type="button" className="hx-agbtn" style={{ alignSelf: 'flex-start' }} disabled={d.steps.length >= 64} onClick={() => setD({ ...d, steps: [...d.steps, blankStep('scroll')] })}>+ Add step</button>
    {problem ? <p className="hx-ag__note">{problem}</p> : <p className="hx-ag__note">Runs only on: {routineInput(d).origins.join(', ')}</p>}
    {error ? <p className="hx-ag__err" role="alert">{error}</p> : null}
    <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={onCancel}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--p" disabled={!!problem} onClick={() => onSave(d)}>Save routine</button></div>
  </div>
}

export function RoutinePanel({ api, onOpenTask }: { api: WorkspaceApi; onOpenTask: (taskId: string) => void }) {
  const [list, setList] = useState<RoutineRecord[] | null>(null), [edit, setEdit] = useState<RoutineDraft | null>(null), [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => api.listRoutines().then((l) => { setList(l); setErr(null) }).catch((e) => setErr(errText(e))), [api])
  useEffect(() => { void load() }, [load])
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); return true } catch (e) { setErr(errText(e)); return false } }
  if (edit) return <RoutineEditor initial={edit} error={err} onCancel={() => { setEdit(null); setErr(null) }}
    onSave={(d) => void run(() => api.saveRoutine(routineInput(d))).then(async (ok) => { if (ok) { setEdit(null); await load() } })} />
  return <>
    {list ? <RoutineList routines={list} onNew={() => setEdit(blankRoutine())} onEdit={(r) => setEdit(routineDraft(r))}
      onDelete={(r) => void run(() => api.deleteRoutine(r.routineId)).then(load)}
      onRun={(r) => void run(async () => { const { taskId } = await api.runRoutine(r.routineId, r.revision); onOpenTask(taskId) })} /> : err ? null : <p className="hx-ag__empty">Loading…</p>}
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
  </>
}

/** Usage, memory and routines for the Agent home. Each section appears only when the host exposes it. */
export function WorkspaceSections({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const api = workspaceApi()
  if (!api) return null
  return <>
    {canUsage(api) ? <><h3 className="hx-ag__h">Usage</h3><UsagePanel api={api} /></> : null}
    {canMemory(api) ? <><h3 className="hx-ag__h">Memory</h3><MemoryPanel api={api} /></> : null}
    {canRoutines(api) ? <><h3 className="hx-ag__h">Routines</h3><RoutinePanel api={api} onOpenTask={onOpenTask} /></> : null}
  </>
}
