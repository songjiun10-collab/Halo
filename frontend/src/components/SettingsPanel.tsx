import { useEffect, useRef, useState } from 'react'
import type { HostSettings } from '../session/api'
import { activeModel, PLANNER_MODELS } from '../session/claude-models'
import { DEFAULT_EFFORT, type PlannerEffort } from '../session/planner-effort'
import { EXECUTION_OPTIONS, fastModeSupport, PERMISSION_OPTIONS, saveSetting, type SettingsPatch } from '../session/settings'
import { EffortSlider } from './EffortSlider'

const FAST_NOTE: Record<ReturnType<typeof fastModeSupport>, string> = {
  no_planner: 'Choose a planner model first.',
  codex: 'Codex runs on its priority tier. Uses your Codex plan faster.',
  claude_opus: 'Claude runs Opus in fast mode, billed to your account credits.',
  claude_other: 'Claude offers fast mode on Opus only. This model runs at normal speed.',
}

interface ViewProps {
  settings: HostSettings | null
  saving: boolean
  error: string | null
  onChange: (patch: SettingsPatch) => void
  leaving?: boolean
}

/** The settings content, without host calls. */
export function SettingsView({ settings, saving, error, onChange, leaving }: ViewProps) {
  if (!settings) {
    return <section className="hx-activity hx-settings" role="dialog" aria-label="Settings" tabIndex={-1}><p className="hx-activity__task">Settings</p><p className="hx-settings__hint">Loading settings…</p></section>
  }
  const model = activeModel(settings)
  const fast = fastModeSupport(settings)
  const fastOn = settings.plannerFast === true
  const claude = settings.plannerProvider === 'claude_code'
  return (
    <section className="hx-activity hx-settings" data-leaving={leaving || undefined} inert={leaving} role="dialog" aria-label="Settings" tabIndex={-1}>
      <p className="hx-activity__task">Settings</p>

      <fieldset className="hx-settings__group" disabled={saving}>
        <legend>Planner</legend>
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
          </select>
        </label>
        <div className="hx-settings__row hx-settings__row--stack">
          <span>Effort</span>
          <EffortSlider value={(settings.plannerEffort ?? DEFAULT_EFFORT) as PlannerEffort} onChange={(plannerEffort) => onChange({ plannerEffort })} disabled={saving} naming={claude ? 'claude' : 'codex'} />
        </div>
        <div className="hx-settings__row">
          <span>Fast mode</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Fast mode" aria-checked={fastOn} disabled={fast === 'no_planner'} onClick={() => onChange({ plannerFast: !fastOn })}><span /></button>
        </div>
        <p className="hx-settings__hint">{FAST_NOTE[fast]} Applies to tasks started after the change.</p>
      </fieldset>

      <fieldset className="hx-settings__group" disabled={saving}>
        <legend>What the agent may do</legend>
        {PERMISSION_OPTIONS.map((o) => (
          <label key={o.value} className="hx-settings__choice" data-warn={o.value === 'full' || undefined}>
            <input type="radio" name="hx-permission" value={o.value} checked={settings.permissionMode === o.value} onChange={() => onChange({ permissionMode: o.value })} />
            <span><b>{o.label}</b><small>{o.hint}</small></span>
          </label>
        ))}
      </fieldset>

      <fieldset className="hx-settings__group" disabled={saving}>
        <legend>Running tasks</legend>
        {EXECUTION_OPTIONS.map((o) => (
          <label key={o.value} className="hx-settings__choice">
            <input type="radio" name="hx-execution" value={o.value} checked={settings.executionMode === o.value} onChange={() => onChange({ executionMode: o.value })} />
            <span><b>{o.label}</b><small>{o.hint}</small></span>
          </label>
        ))}
      </fieldset>

      {error && <p className="hx-settings__error" role="alert">{error}</p>}
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
  return <div ref={ref} className="hx-settings__host"><SettingsView settings={settings} saving={saving} error={error} onChange={(p) => void change(p)} leaving={leaving} /></div>
}
