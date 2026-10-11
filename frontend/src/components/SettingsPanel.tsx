import { useEffect, useRef, useState } from 'react'
import { HaloMark } from './Logo'
import { ProviderIcon } from './BrandIcon'
import type { HostSettings } from '../session/api'
import { activeModel, DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_NVIDIA_MODEL, mergeDiscoveredNvidia, PLANNER_MODELS } from '../session/claude-models'
import { DEFAULT_EFFORT, type PlannerEffort } from '../session/planner-effort'
import { EXECUTION_OPTIONS, fastModeSupport, PERMISSION_OPTIONS, saveSetting, type SettingsPatch } from '../session/settings'
import { useEnabledPlanners } from '../session/enabled-planners'
import { EffortSlider } from './EffortSlider'
import { Back } from './Icons'

type SettingsTab = 'models' | 'agent' | 'privacy' | 'advanced'
const SETTINGS_TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'agent', label: 'Agent' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'advanced', label: 'Advanced' },
]

const FAST_NOTE: Record<ReturnType<typeof fastModeSupport>, string> = {
  no_planner: 'Choose a planner model first.',
  unsupported: 'Fast mode is not supported by this adapter.',
  codex: 'Codex runs on its priority tier. Uses your Codex plan faster.',
  claude_opus: 'Claude runs Opus in fast mode, billed to your account credits.',
  claude_other: 'Claude offers fast mode on Opus only. This model runs at normal speed.',
}

interface ViewProps {
  /** Which section to show; omitted shows every section (used by static renders). */
  tab?: SettingsTab | 'all'
  onTab?: (tab: SettingsTab) => void
  settings: HostSettings | null
  saving: boolean
  error: string | null
  onChange: (patch: SettingsPatch) => void
  onClose?: () => void
  leaving?: boolean
  /** Providers switched on besides the active one; the container persists it. */
  enabledPlanners?: string[] | null
  onEnabledPlanners?: (next: string[]) => void
  /** Which key-taking providers have a registered API key, and the provider whose key form is open. */
  apiKeys?: Record<string, boolean>
  keyEditing?: string | null
  keyError?: string | null
  onKeyEditing?: (provider: string | null) => void
  onSaveKey?: (provider: string, key: string) => void
  onClearKey?: (provider: string) => void
}

/** Providers whose worker reads an API key from its environment; the others sign in through their own CLI. */
const KEYED = new Set(['antigravity', 'cursor', 'nvidia'])

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
export function SettingsView({ tab = 'all', onTab = () => {}, settings, saving, error, onChange, onClose, leaving, enabledPlanners: enabledList = null, onEnabledPlanners: setEnabledList = () => {}, apiKeys = {}, keyEditing = null, keyError = null, onKeyEditing = () => {}, onSaveKey = () => {}, onClearKey = () => {} }: ViewProps) {
  const head = (
    <header className="hx-settings__head">
      <button type="button" className="hx-settings__back" aria-label="Close settings" onClick={onClose}><Back /></button>
      <h2><HaloMark className="hx-sheet__mark" /> Settings</h2>
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
      {tab !== 'all' && <div className="hx-seg" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => onTab(t.id)}>{t.label}</button>)}
      </div>}
      {(tab === 'all' || tab === 'models') && <>
      <div className="hx-settings__section">
        <p className="hx-settings__label">Planner</p>
        {PROVIDERS.map((p) => {
          const activeId = settings.plannerProvider
          // Switches are independent: the active planner is always on; the rest are the providers the user turned on.
          const enabled = new Set([...(enabledList ?? []), ...(activeId !== 'none' ? [activeId] : [])])
          const on = enabled.has(p.id)
          const toggle = () => {
            const next = new Set(enabled)
            if (on) next.delete(p.id); else next.add(p.id)
            setEnabledList([...next])
            if (on && activeId === p.id) {
              const fallback = PROVIDERS.find((q) => next.has(q.id))
              onChange(fallback ? { plannerProvider: fallback.id, plannerModel: fallback.model } : { plannerProvider: 'none' })
            } else if (!on && activeId === 'none') onChange({ plannerProvider: p.id, plannerModel: p.model })
          }
          return (
            <div key={p.id} className="hx-model-row" data-provider={p.id}>
              <span className="hx-model-row__mark" aria-hidden="true"><ProviderIcon id={p.id} size={28} /></span>
              <span className="hx-model-row__body">
                <span className="hx-model-row__name">{p.name}</span>
                <span className="hx-model-row__meta" data-mono="">{activeId === p.id && model ? `planner · ${model.label}` : p.cli}</span>
              </span>
              {KEYED.has(p.id) ? <button type="button" className="hx-keybtn" data-set={apiKeys[p.id] || undefined} aria-label={`${p.name} API key`} onClick={() => onKeyEditing(keyEditing === p.id ? null : p.id)}>{apiKeys[p.id] ? 'Key set' : 'Add key'}</button> : null}
              <button type="button" className="hx-switch" role="switch" aria-label={`Use ${p.name}`} aria-checked={on} disabled={saving} onClick={toggle}><span /></button>
              {KEYED.has(p.id) && keyEditing === p.id ? (
                <form className="hx-keyform" onSubmit={(e) => { e.preventDefault(); const field = e.currentTarget.elements.namedItem('key') as HTMLInputElement | null; const value = field?.value.trim() ?? ''; if (value) { onSaveKey(p.id, value); if (field) field.value = '' } }}>
                  <input name="key" type="password" autoComplete="off" spellCheck={false} autoFocus aria-label={`${p.name} API key`} placeholder={apiKeys[p.id] ? 'Paste a new key to replace it' : 'Paste API key'} />
                  <button type="submit" className="hx-keyform__save">Save</button>
                  {apiKeys[p.id] ? <button type="button" className="hx-keyform__remove" onClick={() => onClearKey(p.id)}>Remove</button> : null}
                  <p>Stored encrypted in your macOS keychain. A key set in the environment takes precedence.</p>
                  {keyError ? <p role="alert" className="hx-keyform__error">{keyError}</p> : null}
                </form>
              ) : null}
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

      </>}

      {(tab === 'all' || tab === 'agent') && <>
      <fieldset className="hx-settings__group" disabled={saving}>
        <div className="hx-settings__row">
          <span>Escalate when stuck</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Escalate when stuck" aria-checked={settings.plannerEscalation === true} onClick={() => onChange({ plannerEscalation: settings.plannerEscalation !== true })}><span /></button>
        </div>
        <div className="hx-settings__row">
          <span>Route by task length</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Route by task length" aria-checked={settings.plannerRouting === true} onClick={() => onChange({ plannerRouting: settings.plannerRouting !== true })}><span /></button>
        </div>
        <p className="hx-settings__hint">Fast tasks use a lighter model and long tasks a top-tier one, within the selected provider. Tasks pinned to a model are never rerouted.</p>
        <p className="hx-settings__hint">When a task is stuck after retries, it moves up one model tier once. This can use a more expensive model.</p>
        <div className="hx-settings__row">
          <span>Connected apps vs. browser</span>
          <select aria-label="Connected apps vs. browser" value={settings.mcpRoutePreference ?? 'mcp_first'} onChange={(e) => onChange({ mcpRoutePreference: e.target.value as 'mcp_first' | 'browser_first' | 'always_ask' })}>
            <option value="mcp_first">Use connected apps first</option>
            <option value="browser_first">Use the browser first</option>
            <option value="always_ask">Always ask me</option>
          </select>
        </div>
        <p className="hx-settings__hint">When a connected app can do the same job as the website, this chooses which one the agent tries first. Applies to tasks started after the change.</p>
      </fieldset>

      <div className="hx-settings__section">
        <p className="hx-settings__label">What the agent may do</p>
        <Cards label="Permission mode" options={PERMISSION_OPTIONS} value={settings.permissionMode} disabled={saving} onPick={(permissionMode) => onChange({ permissionMode })} />
      </div>

      <div className="hx-settings__section">
        <p className="hx-settings__label">Running tasks</p>
        <Cards label="Execution mode" options={EXECUTION_OPTIONS} value={settings.executionMode} disabled={saving} onPick={(executionMode) => onChange({ executionMode })} />
      </div>

      </>}

      {(tab === 'all' || tab === 'privacy') && <>
      <fieldset className="hx-settings__group" disabled={saving}>
        <div className="hx-settings__row">
          <span>Context Awareness</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Context Awareness" aria-checked={settings.contextAwareness === true} onClick={() => onChange({ contextAwareness: settings.contextAwareness !== true })}><span /></button>
        </div>
        <p className="hx-settings__hint">Remembers the title and a short excerpt of pages you read in Halo, on this Mac only and encrypted, for 14 days. Sign-in, payment, mail and bank pages, and pages with password or card fields, are never saved. Tasks can recall matching pages. Off by default.</p>
        <ActivityClear />
      </fieldset>

      </>}

      {(tab === 'all' || tab === 'advanced') && <>
      <fieldset className="hx-settings__group" disabled={saving}>
        <div className="hx-settings__row">
          <span>Show advanced controls on screen</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Show advanced controls" aria-checked={settings.showAdvanced === true} onClick={() => onChange({ showAdvanced: settings.showAdvanced !== true })}><span /></button>
        </div>
        <p className="hx-settings__hint">Shows technical chips (intent lock, permission leases, sub-agent plans, background service) in the main screens. Off keeps them hidden.</p>
        <div className="hx-settings__row">
          <span>Learn strategies for GPT-6 Luna</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Learn strategies for GPT-6 Luna" aria-checked={settings.strategyLearning === true} onClick={() => onChange({ strategyLearning: settings.strategyLearning !== true })}><span /></button>
        </div>
        <p className="hx-settings__hint">Opt-in. Keeps encrypted outcome metadata only, not prompts or page content. Repeated patterns create candidates; synthetic replay is not a model-performance benchmark. You must review and promote each passing candidate. Applies to newly attached Luna tasks.</p>
        <StrategyLearningReview />
      </fieldset>

      <div className="hx-settings__section">
        <p className="hx-settings__label">Agent identity (Web Bot Auth)</p>
        <div className="hx-settings__row">
          <span>Sign requests as a declared agent</span>
          <button type="button" className="hx-switch" role="switch" aria-label="Web Bot Auth signing" aria-checked={settings.webBotAuth === true} disabled={saving} onClick={() => onChange({ webBotAuth: settings.webBotAuth !== true })}><span /></button>
        </div>
        <div className="hx-settings__row">
          <span>Key directory URL</span>
          <input
            type="url"
            name="webBotAuthDirectory"
            aria-label="Web Bot Auth key directory URL"
            placeholder="https://agent.example.org"
            defaultValue={settings.webBotAuthDirectory ?? ''}
            disabled={saving}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onBlur={(event) => {
              const value = event.target.value.trim()
              if (value !== (settings.webBotAuthDirectory ?? '')) onChange({ webBotAuthDirectory: value })
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </div>
        <p className="hx-settings__hint">Adds a signed identity to requests from agent pages, so a site that supports Web Bot Auth (for example Cloudflare) can recognize the declared agent and apply its agent policy. The private key stays on this Mac; publish its public key at the directory URL you register. Sites without support see ordinary requests, and a human check is never solved for you. Off by default.</p>
      </div>

      </>}

      {error && <p className="hx-settings__error" role="alert">{error}</p>}
      </div>
    </section>
  )
}

function StrategyLearningReview() {
  const [state, setState] = useState<{ enabled: boolean; activeRevisionId: string | null; candidates: { id: string; strategyId: string; support: number; status: string; evaluation: { result: string } | null }[]; revisions: { id: string; event: string; parentId: string | null }[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = async () => { try { setState(await window.haloBrowser?.getStrategyLearningState?.() ?? null) } catch { setMessage('Local strategy-learning store is unavailable.') } }
  useEffect(() => { void refresh() }, [])
  const call = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true); setMessage('')
    try { await fn(); setMessage(success); await refresh() } catch { setMessage('Action failed; no policy change was applied.') } finally { setBusy(false) }
  }
  if (!state) return <p className="hx-settings__hint">Loading local strategy candidates…</p>
  return <div className="hx-settings__section" aria-label="Strategy learning review">
    <p className="hx-settings__label">Agent.md review · GPT-6 Luna only</p>
    <p className="hx-settings__hint">Replay checks deterministic selector behavior on synthetic cases. It does not prove the model will improve.</p>
    {state.candidates.length === 0 ? <p className="hx-settings__hint">No repeated failure pattern yet. At least three matching episodes are required.</p> : state.candidates.map((candidate) => <div className="hx-model-row" key={candidate.id}>
      <span className="hx-model-row__body"><span className="hx-model-row__name">{candidate.strategyId}</span><span className="hx-model-row__meta" data-mono="">{candidate.support} episodes · {candidate.evaluation?.result ?? 'not evaluated'}</span></span>
      <button type="button" className="hx-keybtn" disabled={busy || !state.enabled} onClick={() => void call(() => window.haloBrowser!.evaluateStrategyCandidate!(candidate.id), 'Replay complete. Review the result before promotion.')}>Evaluate</button>
      <button type="button" className="hx-keybtn" disabled={busy || !state.enabled || candidate.evaluation?.result !== 'pass'} onClick={() => void call(() => window.haloBrowser!.promoteStrategyCandidate!(candidate.id, state.activeRevisionId), 'Strategy promoted. New tasks will use it.')}>Promote</button>
    </div>)}
    {state.activeRevisionId ? <button type="button" className="hx-keybtn" disabled={busy} onClick={() => { const prior = [...state.revisions].reverse().find((revision) => revision.id !== state.activeRevisionId); void call(() => window.haloBrowser!.rollbackStrategyGuidance!(prior?.id ?? 'builtin', state.activeRevisionId), 'Rollback recorded as a new revision.') }}>Rollback to prior revision</button> : null}
    {state.candidates.length || state.revisions.length ? <button type="button" className="hx-keybtn" disabled={busy} onClick={() => { if (window.confirm('Delete local strategy-learning episodes, candidates, and revisions?')) void call(() => window.haloBrowser!.clearStrategyLearning!(), 'Local strategy-learning data deleted.') }}>Clear learning data</button> : null}
    {message ? <p className="hx-settings__hint" role="status">{message}</p> : null}
  </div>
}

interface Props {
  leaving?: boolean
  onClose: () => void
}

function ActivityClear() {
  const api = typeof window === 'undefined' ? undefined : window.haloBrowser
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const clear = () => {
    setState('busy')
    void Promise.resolve(api?.clearActivity?.()).then(() => setState('done')).catch(() => setState('error'))
  }
  return (
    <div className="hx-settings__row">
      <span>Saved activity</span>
      <button type="button" className="hx-agbtn" disabled={state === 'busy' || !api?.clearActivity} onClick={clear}>{state === 'done' ? 'Cleared' : state === 'error' ? 'Could not clear' : 'Clear all'}</button>
    </div>
  )
}

/** Settings overlay, opened from the toolbar or ⌘,. Every change goes straight to host settings. */
export function SettingsPanel({ leaving, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>('models')
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setModelsVersion] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    let current = true
    void window.haloBrowser?.getHostSettings().then((next) => { if (current) setSettings(next) }).catch(() => { if (current) setError('Could not load settings.') })
    return () => { current = false }
  }, [])
  // Opening settings asks the host which NVIDIA models the account can use; a failed lookup keeps the built-in list.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const refreshModels = async () => {
    try {
      const result = await window.haloBrowser?.refreshPlannerModels?.()
      if (!result) return
      mergeDiscoveredNvidia(result.nvidia)
      if (mounted.current) setModelsVersion((v) => v + 1)
    } catch { /* keep the built-in list */ }
  }
  useEffect(() => { void refreshModels() }, [])
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
  const [enabledPlanners, setEnabledPlanners] = useEnabledPlanners()
  const [apiKeys, setApiKeys] = useState<Record<string, boolean>>({})
  const [keyEditing, setKeyEditing] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  useEffect(() => { window.haloBrowser?.getApiKeyStatus?.().then(setApiKeys).catch(() => {}) }, [])
  const keyCall = async (call: Promise<Record<string, boolean>> | undefined, done: boolean, provider?: string) => {
    setKeyError(null)
    try { if (call) { setApiKeys(await call); if (done) setKeyEditing(null); if (provider === 'nvidia') await refreshModels() } else setKeyError('API keys are not available in this build.') }
    catch (caught) { setKeyError((caught as { code?: string })?.code === 'encryption_unavailable' ? 'Secure keychain storage is unavailable, so the key was not saved.' : 'Could not save that key.') }
  }
  return <div ref={ref} className="hx-settings__host"><SettingsView tab={tab} onTab={setTab} settings={settings} saving={saving} error={error} onChange={(p) => void change(p)} onClose={onClose} leaving={leaving} enabledPlanners={enabledPlanners} onEnabledPlanners={setEnabledPlanners} apiKeys={apiKeys} keyEditing={keyEditing} keyError={keyError} onKeyEditing={(id) => { setKeyError(null); setKeyEditing(id) }} onSaveKey={(id, key) => void keyCall(window.haloBrowser?.setApiKey?.(id, key), true, id)} onClearKey={(id) => void keyCall(window.haloBrowser?.clearApiKey?.(id), true, id)} /></div>
}
