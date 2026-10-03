import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostSettings } from '../session/api'
import { activeModel, PLANNER_MODELS, type PlannerModel } from '../session/claude-models'
import { DEFAULT_EFFORT, EFFORT_LEVELS, effortLabel, type PlannerEffort } from '../session/planner-effort'
import { EffortSlider } from './EffortSlider'

interface Props {
  settings: HostSettings | null
  onSelectModel: (id: string) => void
  onEffort: (effort: PlannerEffort) => void
  savingProvider?: boolean
  savingEffort?: boolean
  /** Test hook: render with the popover already open. */
  defaultOpen?: boolean
  /** Test hook: which face the open popover shows first. */
  defaultView?: 'effort' | 'models'
}


/** The home form's model picker (design system `hx-mpick`): a pill that opens Model and Effort. */
export function ModelPicker({ settings, onSelectModel, onEffort, savingProvider, savingEffort, defaultOpen = false, defaultView = 'effort' }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const [view, setView] = useState(defaultView)
  const ref = useRef<HTMLDivElement>(null)
  const active = activeModel(settings)
  // Claude's legacy models stay folded unless the pinned model is one of them;
  // Codex models are all listed in their own group.
  const isClaudeLegacy = (m: PlannerModel) => m.provider === 'claude_code' && m.legacy
  const [legacyOpen, setLegacyOpen] = useState(Boolean(active && isClaudeLegacy(active)))
  const [maxHeight, setMaxHeight] = useState<number | undefined>()
  // The level under the pointer while the effort knob is being dragged.
  const [preview, setPreview] = useState<PlannerEffort | null>(null)

  // The popover opens upward: keep it below the Task/Agent switch at the top
  // of the home area instead of letting that clip its first rows.
  useEffect(() => { if (!open) setView('effort') }, [open])

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const area = ref.current.closest('.hx-homewrap')?.getBoundingClientRect().top ?? 0
    setMaxHeight(Math.max(160, ref.current.getBoundingClientRect().top - area - 72))
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  const isActive = (m: PlannerModel) => active?.id === m.id && active.provider === m.provider
  const option = (m: PlannerModel) => <button type="button" key={m.id} className="hx-mpick__opt" role="radio"
    aria-checked={isActive(m)} data-on={isActive(m) || undefined}
    disabled={savingProvider} title={`${m.description ? `${m.description} ` : ''}(${m.id}) · applies to new tasks`}
    onClick={() => { if (!isActive(m)) onSelectModel(m.id); setView('effort') }}>
    {m.provider === 'codex_cli' || m.provider === 'claude_code' ? <img src={`./assets/model-icons/${m.provider === 'codex_cli' ? 'codex' : 'claude'}.png`} alt="" /> : <span aria-hidden="true">{m.provider === 'nvidia' ? 'N' : m.provider === 'cursor' ? 'U' : 'A'}</span>}<span>{m.label}</span>
  </button>

  // One card for both providers; only the level names follow the app whose model runs.
  const naming = active?.provider === 'codex_cli' ? 'codex' : 'claude'
  const saved = settings?.plannerEffort ?? DEFAULT_EFFORT
  const effort = preview ?? saved
  const hint = naming === 'claude' && effort === 'ultra' ? 'Deepest planning. The Claude CLI planner runs it at max effort.' : EFFORT_LEVELS[effort]?.hint
  const modelButton = <button type="button" className="hx-mpick__model" aria-label="Change model" onClick={() => setView('models')}>{active?.label ?? 'Choose model'}<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg></button>

  return <div ref={ref} className="hx-mpick" data-open={open || undefined}>
    <button type="button" className="hx-mpick__toggle" aria-haspopup="true" aria-expanded={open} disabled={!settings} onClick={() => setOpen((o) => !o)}>
      <span>{active ? `${({ codex_cli: 'Codex', claude_code: 'Claude', antigravity: 'Antigravity', cursor: 'Cursor', nvidia: 'NVIDIA' })[active.provider]} ${active.label}` : 'Model'}</span>
      <svg className="hx-mpick__chev" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {open && settings ? <div className="hx-mpick__pop" data-view={view} style={view === 'models' && maxHeight ? { maxHeight } : undefined}>
      {view === 'effort' ? <>
        <div className="hx-mpick__card" data-level={effort}>
          <svg className="hx-mpick__bolt" aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>
          <div className="hx-mpick__title" title={hint}>
            <b>{effortLabel(effort, naming)}</b>
            {modelButton}
          </div>
          <button type="button" className="hx-mpick__reset" aria-label="Reset effort" title="Reset to Medium" disabled={savingEffort || saved === DEFAULT_EFFORT} onClick={() => onEffort(DEFAULT_EFFORT)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v5h5" /></svg>
          </button>
        </div>
        <EffortSlider value={saved} onChange={onEffort} onPreview={setPreview} disabled={savingEffort} naming={naming} />
      </> : <>
        <button type="button" className="hx-mpick__back" onClick={() => setView('effort')}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg>Effort
        </button>
        <p>Model</p>
        {PLANNER_MODELS.filter((m) => m.provider === 'claude_code' && !m.legacy).map(option)}
        <p>Codex</p>
        {PLANNER_MODELS.filter((m) => m.provider === 'codex_cli').map(option)}
        <p>Antigravity / Cursor</p>
        {PLANNER_MODELS.filter((m) => m.provider === 'antigravity' || m.provider === 'cursor').map(option)}
        <p>NVIDIA</p>
        {PLANNER_MODELS.filter((m) => m.provider === 'nvidia').map(option)}
        <button type="button" className="hx-mpick__fold" aria-expanded={legacyOpen} onClick={() => setLegacyOpen((o) => !o)}>
          Legacy<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        {legacyOpen ? PLANNER_MODELS.filter(isClaudeLegacy).map(option) : null}
      </>}
    </div> : null}
  </div>
}
