import { useEffect, useRef, useState } from 'react'
import type { HostSettings } from '../session/api'
import { activeModel, DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_NVIDIA_MODEL, PLANNER_MODELS } from '../session/claude-models'
import { DEFAULT_EFFORT, type PlannerEffort } from '../session/planner-effort'
import { EXECUTION_OPTIONS, fastModeSupport, PERMISSION_OPTIONS, saveSetting, type SettingsPatch } from '../session/settings'
import { EffortSlider } from './EffortSlider'
import { Back } from './Icons'

const FAST_NOTE: Record<ReturnType<typeof fastModeSupport>, string> = {
  no_planner: 'Choose a planner model first.',
  unsupported: 'Fast mode is not supported by this adapter.',
  codex: 'Codex runs on its priority tier. Uses your Codex plan faster.',
  claude_opus: 'Claude runs Opus in fast mode, billed to your account credits.',
  claude_other: 'Claude offers fast mode on Opus only. This model runs at normal speed.',
}

interface ViewProps {
  settings: HostSettings | null
  saving: boolean
  error: string | null
  onChange: (patch: SettingsPatch) => void
  onClose?: () => void
  leaving?: boolean
}

/** External adapter keys come from the host environment, not this UI. */
const PROVIDERS = [
  { id: 'claude_code', name: 'Claude', mark: 'C', cli: 'Claude Code CLI', model: DEFAULT_CLAUDE_MODEL },
  { id: 'codex_cli', name: 'Codex', mark: 'X', cli: 'Codex CLI', model: DEFAULT_CODEX_MODEL },
  { id: 'antigravity', name: 'Antigravity', mark: 'A', cli: 'agy CLI · API key required · isolated profile', model: 'antigravity-default' },
  { id: 'cursor', name: 'Cursor', mark: 'U', cli: 'Cursor CLI · API key required · isolated profile', model: 'cursor-auto' },
  { id: 'nvidia', name: 'NVIDIA', mark: 'N', cli: 'NVIDIA NIM API', model: DEFAULT_NVIDIA_MODEL },
  { id: 'opencode_cli', name: 'OpenCode', mark: 'O', cli: 'OpenCode CLI · configured default model', model: 'opencode-default' },
] as const

/** A labelled single choice drawn as cards. */
function Cards<T extends string>({ label, options, value, disabled, onPick }: { label: string; options: readonly { value: T; label: string; hint: string }[]; value: T; disabled: boolean; onPick: (value: T) => void }) {
  return (
    <div className="hx-perm-list" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="hx-perm" data-selected={value === o.value ? '' : undefined} role="radio" aria-checked={value === o.value} data-warn={o.value === 'full' || undefined} disabled={disabled} onClick={() => onPick(o.value)}>
          <span className="hx-perm__dot" />
          <span className="hx-perm__body"><span className="hx-perm__name">{o.label}</span><span className="hx-perm__desc">{o.hint}</span></span>
        </button>
      ))}
    </div>
  )
}

/** The settings content, without host calls. */
export function SettingsView({ settings, saving, error, onChange, onClose, leaving }: ViewProps) {
  const head = (
    <header className="hx-settings__head">
      <button type="button" className="hx-settings__back" aria-label="Close settings" onClick={onClose}><Back /></button>
      <h2>Settings</h2>
    </header>
  )
  if (!settings) {
    return <section className="hx-settings" role="dialog" aria-label="Settings" tabIndex={-1}>{head}<div className="hx-settings__body"><p className="hx-settings__hint">Loading settings…</p></div></section>
  }
  const model = activeModel(settings)
  const fast = fastModeSupport(settings)
  const fastOn = settings.plannerFast === true
  const claude = settings.plannerProvider === 'claude_code'
  return (
    <section className="hx-settings" data-leaving={leaving || undefined} inert={leaving} role="dialog" aria-label="Settings" tabIndex={-1}>
      {head}
      <div className="hx-settings__body">
      <div className="hx-settings__section">
        <p className="hx-settings__label">Planner</p>
        {PROVIDERS.map((p) => {
          const on = settings.plannerProvider === p.id
          return (
            <div key={p.id} className="hx-model-row" data-provider={p.id}>
              <span className="hx-model-row__mark" aria-hidden="true">{p.mark}</span>
              <span className="hx-model-row__body">
                <span className="hx-model-row__name">{p.name}</span>
                <span className="hx-model-row__meta" data-mono="">{on && model ? `planner · ${model.label}` : p.cli}</span>
              </span>
              <button type="button" className="hx-switch" role="switch" aria-label={`Use ${p.name}`} aria-checked={on} disabled={saving} onClick={() => onChange(on ? { plannerProvider: 'none' } : { plannerProvider: p.id, plannerModel: p.model })}><span /></button>
            </div>
          )
        })}
      </div>

      <fieldset className="hx-settings__group" disabled={saving}>
        <label className="hx-settings__row">
          <span>Model</span>
          <select aria-label="Planner model" value={model?.id ?? ''} onChange={(e) => {
            const picked = PLANNER_MODELS.find((m) => m.id === e.target.value)
            if (picked) onChange({ plannerProvider: picked.provider, plannerModel: picked.id })
            else onChange({ plannerProvider: 'none' })
          }}>
            <option value="">None (planner off)</option>
            <optgroup label="Claude">{PLANNER_MODELS.filter((m) => m.provider === 'claude_code').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
            <optgroup label="Codex">{PLANNER_MODELS.filter((m) => m.provider === 'codex_cli').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
            <optgroup label="Antigravity">{PLANNER_MODELS.filter((m) => m.provider === 'antigravity').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
            <optgroup label="Cursor">{PLANNER_MODELS.filter((m) => m.provider === 'cursor').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
            <optgroup label="NVIDIA">{PLANNER_MODELS.filter((m) => m.provider === 'nvidia').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
            <optgroup label="OpenCode">{PLANNER_MODELS.filter((m) => m.provider === 'opencode_cli').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
          </select>
        </label>
        <div className="hx-settings__row hx-settings__row--stack">
          <span>Effort</span>
          <EffortSlider value={(settings.plannerEffort ?? DEFAULT_EFFORT) as PlannerEffort} onChange={(plannerEffort) => onChange({ plannerEffort })} disabled={saving} naming={claude ? 'claude' : 'codex'} />
        </div>
        <div className="hx-settings__row">
          <span>Fast mode</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Fast mode" aria-checked={fastOn} disabled={fast === 'no_planner' || fast === 'unsupported'} onClick={() => onChange({ plannerFast: !fastOn })}><span /></button>
        </div>
        <p className="hx-settings__hint">{FAST_NOTE[fast]} Applies to tasks started after the change.</p>
      </fieldset>

      <div className="hx-settings__section">
        <p className="hx-settings__label">What the agent may do</p>
        <Cards label="Permission mode" options={PERMISSION_OPTIONS} value={settings.permissionMode} disabled={saving} onPick={(permissionMode) => onChange({ permissionMode })} />
      </div>

      <div className="hx-settings__section">
        <p className="hx-settings__label">Running tasks</p>
        <Cards label="Execution mode" options={EXECUTION_OPTIONS} value={settings.executionMode} disabled={saving} onPick={(executionMode) => onChange({ executionMode })} />
      </div>

      {error && <p className="hx-settings__error" role="alert">{error}</p>}
      </div>
    </section>
  )
}

interface Props {
  leaving?: boolean
  onClose: () => void
}

/** Settings overlay, opened from the toolbar or ⌘,. Every change goes straight to host settings. */
export function SettingsPanel({ leaving, onClose }: Props) {
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    let current = true
    void window.haloBrowser?.getHostSettings().then((next) => { if (current) setSettings(next) }).catch(() => { if (current) setError('Could not load settings.') })
    return () => { current = false }
  }, [])
  useEffect(() => {
    if (leaving) return
    ref.current?.querySelector<HTMLElement>('[role=dialog]')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaving, settings === null])

  const change = async (patch: SettingsPatch) => {
    if (!settings || saving) return
    const previous = settings
    setSettings({ ...settings, ...patch })
    setSaving(true)
    setError(null)
    const next = await saveSetting(window.haloBrowser, patch)
    if (next) setSettings(next)
    else { setSettings(previous); setError('Could not save that change.') }
    setSaving(false)
  }
  return <div ref={ref} className="hx-settings__host"><SettingsView settings={settings} saving={saving} error={error} onChange={(p) => void change(p)} onClose={onClose} leaving={leaving} /></div>
}
