import { useEffect, useState } from 'react'
import { AGENT_ROLE } from '../session/session'
import { nonEmptyVerbatim } from '../session/composer'
import { Forward } from './Icons'
import { HaloMark } from './Logo'
import type { HostSettings, IntentLockInput } from '../session/api'
import { LockChips, lockFromChips, type LockChip } from './LockChips'
import { AgentHome, ModeSwitch, type HomeMode } from '../agent/AgentHome'
import { homeModeFor, onAgentView } from '../agent/agent-nav'
import { ModelPicker } from './ModelPicker'
import { saveEffort, type PlannerEffort } from '../session/planner-effort'
import { saveModel } from '../session/claude-models'
import '../agent/agent.css'

/** Kept for the session so a new tab opens in the last-used home mode. */
let lastMode: HomeMode = 'task'

interface Props {
  /** A task already running or paused in another tab, if there is one. */
  activeTask?: { text: string; tabId: string }
  onSelectTab: (id: string) => void
  onSubmit: (text: string, lock?: IntentLockInput) => void
}

/**
 * A new tab: this is Halo's own surface, not a web page — dark, not the light site
 * background — with a place to tell the agent what to do next.
 */
export function HomeScreen({ activeTask, onSelectTab, onSubmit }: Props) {
  // A sidebar agent or team row opens this home in Agent mode.
  const [mode, setModeState] = useState<HomeMode>(() => (lastMode = homeModeFor(lastMode)))
  const setMode = (next: HomeMode) => { lastMode = next; setModeState(next) }
  useEffect(() => onAgentView(() => { lastMode = 'agent'; setModeState('agent') }), [])
  const [value, setValue] = useState('')
  const [lockChips, setLockChips] = useState<Set<LockChip>>(new Set())
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [savingProvider, setSavingProvider] = useState(false)
  const [providerError, setProviderError] = useState(false)
  const [savingEffort, setSavingEffort] = useState(false)
  const [effortError, setEffortError] = useState(false)

  useEffect(() => {
    let current = true
    void window.haloBrowser?.getHostSettings().then((next) => {
      if (current) setSettings(next)
    }).catch(() => {})
    return () => { current = false }
  }, [])

  const selectModel = async (id: string) => {
    if (savingProvider) return
    setSavingProvider(true)
    setProviderError(false)
    const next = await saveModel(window.haloBrowser, id)
    if (next) setSettings(next)
    else setProviderError(true)
    setSavingProvider(false)
  }
  const selectEffort = async (effort: PlannerEffort) => {
    if (!settings || savingEffort) return
    const previous = settings
    setSettings({ ...settings, plannerEffort: effort })
    setSavingEffort(true)
    setEffortError(false)
    const next = await saveEffort(window.haloBrowser, effort)
    if (next) setSettings(next)
    else { setSettings(previous); setEffortError(true) }
    setSavingEffort(false)
  }
  return (
    <div className="hx-homewrap">
    <ModeSwitch mode={mode} onChange={setMode} />
    {mode === 'agent' ? <AgentHome onOpenTask={onSelectTab} /> : (
    <div className="hx-home">
      <HaloMark className="hx-home__mark" />
      <h2 className="hx-home__title">What should the {AGENT_ROLE.toLowerCase()} do?</h2>
      <form
        className="hx-home__form"
        onSubmit={(e) => {
          e.preventDefault()
          const text = nonEmptyVerbatim(value)
          if (text !== null) onSubmit(text, lockFromChips(lockChips))
        }}
      >
        <input
          className="hx-home__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Describe a task…"
          aria-label="What should the agent do?"
        />
        <ModelPicker settings={settings} onSelectModel={(id) => void selectModel(id)} onEffort={(effort) => void selectEffort(effort)} savingProvider={savingProvider} savingEffort={savingEffort} />
        <button className="hx-btn hx-btn--primary hx-btn--compact" type="submit" disabled={!value.trim()}>Go</button>
      </form>
      <LockChips value={lockChips} onChange={setLockChips} />
      {(providerError || effortError) && (
        <p className="hx-home__provider-status" role="alert">{providerError ? 'Could not update provider preference.' : 'Could not update effort.'}</p>
      )}
      {activeTask && (
        <button className="hx-home__resume" onClick={() => onSelectTab(activeTask.tabId)}>
          Continue: {activeTask.text}
          <Forward />
        </button>
      )}
    </div>
    )}
    </div>
  )
}
