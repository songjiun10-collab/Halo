import { waitReasonLabel } from '../session/wait-reason'
import { useEffect, useState } from 'react'
import { nonEmptyVerbatim } from '../session/composer'
import { Forward, Up } from './Icons'
import { addressTarget } from '../session/navigation'
import { canRoutines, workspaceApi, type RoutineRecord } from '../agent/workspace-api'
import { HaloMark } from './Logo'
import type { IntentLockInput, TaskSummary } from '../session/api'
import { LockChips, type LockChip } from './LockChips'
import { lockFromChips } from '../session/lock-chips'
import { AgentHome, ModeSwitch, type HomeMode } from '../agent/AgentHome'
import { homeModeFor, onAgentView } from '../agent/agent-nav'
import { ModelPicker } from './ModelPicker'
import { useModelSettings } from '../hooks/useModelSettings'
import '../agent/agent.css'

const CHAT_LIMIT = 5
const STATE_LABEL: Record<string, string> = {
  running: 'Running', queued: 'Queued', awaiting_approval: 'Waiting for your approval', awaiting_verification: 'Needs your check',
  paused: 'Paused', stopped: 'Stopped', completed: 'Done', idle: 'Idle',
}

/** Kept for the session so a new tab opens in the last-used home mode. */
let lastMode: HomeMode = 'task'

interface Props {
  /** A task already running or paused in another tab, if there is one. */
  activeTask?: { text: string; tabId: string }
  onSelectTab: (id: string) => void
  onSubmit: (text: string, lock?: IntentLockInput) => void
  onNavigate: (url: string) => void
}

/**
 * A new tab: this is Halo's own surface, not a web page — dark, not the light site
 * background — with a place to tell the agent what to do next.
 */
export function HomeScreen({ activeTask, onSelectTab, onSubmit, onNavigate }: Props) {
  // A sidebar agent or team row opens this home in Agent mode.
  const [mode, setModeState] = useState<HomeMode>(() => (lastMode = homeModeFor(lastMode)))
  const setMode = (next: HomeMode) => { lastMode = next; setModeState(next) }
  useEffect(() => onAgentView(() => { lastMode = 'agent'; setModeState('agent') }), [])
  const [value, setValue] = useState('')
  const [lockChips, setLockChips] = useState<Set<LockChip>>(new Set())
  const { settings, savingProvider, providerError, savingEffort, effortError, selectModel, selectEffort } = useModelSettings()
  const [recent, setRecent] = useState<TaskSummary[]>([])
  const [query, setQuery] = useState<'search' | 'ask'>('search')
  const [tab, setTab] = useState<'chats' | 'routines'>('chats')
  const [showAll, setShowAll] = useState(false)
  const [routines, setRoutines] = useState<RoutineRecord[]>([])

  useEffect(() => {
    let current = true
    void window.haloBrowser?.listTasks().then((tasks) => {
      if (current) setRecent(tasks)
    }).catch(() => {})
    return () => { current = false }
  }, [])

  useEffect(() => {
    const api = workspaceApi()
    if (!api || !canRoutines(api)) return
    let current = true
    void api.listRoutines().then((list) => { if (current) setRoutines(list) }).catch(() => {})
    return () => { current = false }
  }, [])

  const chats = showAll ? recent : recent.slice(0, CHAT_LIMIT)
  const allLabel = tab === 'chats' ? (showAll ? 'Fewer Chats' : 'All Chats') : 'All Routines'
  const onAll = () => { if (tab === 'chats') setShowAll((v) => !v); else setMode('agent') }

  return (
    <div className="hx-homewrap">
    <ModeSwitch mode={mode} onChange={setMode} />
    {mode === 'agent' ? <AgentHome onOpenTask={onSelectTab} /> : (
    <div className="hx-home">
      <HaloMark className="hx-home__mark" />
      <form
        className="hx-home__form"
        onSubmit={(e) => {
          e.preventDefault()
          if (query === 'ask') {
            const text = nonEmptyVerbatim(value)
            if (text !== null) onSubmit(text, lockFromChips(lockChips))
          } else {
            const target = addressTarget(value)
            if (target) onNavigate(target)
          }
        }}
      >
        <input
          className="hx-home__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={query === 'ask' ? 'Ask Halo anything…' : 'Search or type a URL'}
          aria-label={query === 'ask' ? 'What should the agent do?' : 'Search or type a URL'}
        />
        <div className="hx-seg" role="group" aria-label="Search or ask">
          <button type="button" aria-pressed={query === 'search'} onClick={() => setQuery('search')}>Search</button>
          <button type="button" aria-pressed={query === 'ask'} onClick={() => setQuery('ask')}>Ask</button>
        </div>
        {query === 'ask' && <ModelPicker settings={settings} onSelectModel={(id) => void selectModel(id)} onEffort={(effort) => void selectEffort(effort)} savingProvider={savingProvider} savingEffort={savingEffort} />}
        <button className="hx-btn hx-btn--primary hx-btn--compact" type="submit" disabled={!value.trim()} aria-label={query === 'ask' ? 'Send' : 'Go'}><Up /></button>
      </form>
      {query === 'ask' && <LockChips value={lockChips} onChange={setLockChips} />}
      {(providerError || effortError) && (
        <p className="hx-home__provider-status" role="alert">{providerError ? 'Could not update provider preference.' : 'Could not update effort.'}</p>
      )}
      <div className="hx-home__row">
        <div className="hx-seg hx-seg--lg" role="group" aria-label="Home list">
          <button type="button" aria-pressed={tab === 'chats'} onClick={() => setTab('chats')}>Chats</button>
          <button type="button" aria-pressed={tab === 'routines'} onClick={() => setTab('routines')}>Routines</button>
        </div>
        <button type="button" className="hx-home__all" onClick={onAll}>{allLabel}<Forward /></button>
      </div>
      {tab === 'chats' && chats.length > 0 && (
        <div className="hx-home__list">
          {chats.map((task) => (
            <button type="button" key={task.taskId} className="hx-hc" onClick={() => onSelectTab(task.taskId)}>
              <small>{task.state === 'queued' ? waitReasonLabel(task.waitReason) ?? STATE_LABEL[task.state] : STATE_LABEL[task.state] ?? task.state}</small>
              <b>{task.originalRequest}</b>
              {task.pauseReason && <span>{task.pauseReason}</span>}
            </button>
          ))}
        </div>
      )}
      {tab === 'routines' && routines.length > 0 && (
        <div className="hx-home__list">
          {routines.map((r) => (
            <div key={r.routineId} className="hx-hc" data-static="true">
              <b>{r.name}</b>
              {r.description && <span>{r.description}</span>}
            </div>
          ))}
        </div>
      )}
      {tab === 'routines' && routines.length === 0 && (
        <div className="hx-home__list hx-home__empty">
          <b>No active routines</b>
          <span>Let Halo handle the tasks you do on repeat.</span>
        </div>
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
