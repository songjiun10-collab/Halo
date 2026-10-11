import { useEffect, useRef, useState } from 'react'
import { AGENT } from '../session/session'
import { nonEmptyVerbatim } from '../session/composer'
import type { Actor, ChatMessage, PendingCriterion, TimelineEvent } from '../session/types'
import { HaloMark } from './Logo'
import { ModelPicker } from './ModelPicker'
import { workSummary, workedForLabel } from '../session/work-summary'
import { useModelSettings } from '../hooks/useModelSettings'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

interface Props {
  taskLabel: string
  /** The page the agent is looking at, shown as a context chip above the composer. */
  tabContext?: { title: string; host: string } | null
  messages: ChatMessage[]
  /** The task's journal; shown folded as a "Worked for" line. */
  timeline?: TimelineEvent[]
  recentTasks?: { taskId: string; label: string; meta: string }[]
  pendingCriteria?: PendingCriterion[]
  isTaskActive?: boolean
  leaving?: boolean
  onClose: () => void
  onSend: (text: string) => void
  onSelectTask: (taskId: string) => void
  onNewTask: () => void
  onConfirmCriterion: (criterion: PendingCriterion, outcome: 'verified' | 'rejected') => void
}

/**
 * Halo's own surface for talking to the agent, reached from the halo ring.
 * Same focus-management contract as Activity: opens focused, restores focus
 * to whatever opened it (or the ring) on close, closes on Escape.
 */
export function HaloChat({ taskLabel, tabContext, messages, timeline = [], recentTasks = [], pendingCriteria = [], isTaskActive = false, leaving, onClose, onSend, onSelectTask, onNewTask, onConfirmCriterion }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [value, setValue] = useState('')
  const model = useModelSettings()
  const work = workSummary(timeline)
  const opener = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const el = ref.current
    if (leaving) {
      const active = document.activeElement
      if (active === document.body || el?.contains(active)) {
        const back = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('.hx-halo')
        back?.focus()
      }
      return
    }
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && !el?.contains(active)) opener.current = active
    el?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaving])

  const [folded, setFolded] = useState(() => { try { return localStorage.getItem('halo.chat.history.folded') !== '0' } catch { return false } })
  const toggleFold = () => setFolded((value) => {
    try { localStorage.setItem('halo.chat.history.folded', value ? '0' : '1') } catch { /* per-viewer convenience only */ }
    return !value
  })

  return (
    <section id="hx-chat" className="hx-chat" data-leaving={leaving || undefined} inert={leaving} role="dialog" aria-label="Halo chat" tabIndex={-1} ref={ref}>
      <div className="hx-chat__head">
        <HaloMark className="hx-sheet__mark" />
        {recentTasks.length > 0
          ? <button type="button" className="hx-chat__task hx-chat__ttl" aria-expanded={!folded} aria-controls="hx-chat-recent" onClick={toggleFold}>{taskLabel}<span className="hx-sidebar__chev" aria-hidden="true">›</span></button>
          : <p className="hx-chat__task">{taskLabel}</p>}
        <button type="button" className="hx-chat__new" aria-label="New task" title="New task" onClick={onNewTask}>＋</button>
        <button className="hx-chat__close" onClick={onClose} aria-label="Close chat">×</button>
      </div>
      {recentTasks.length > 0 && !folded && (
        <ul id="hx-chat-recent" className="hx-chat__recent">
          {recentTasks.map((t, i) => (
            <li key={i}>
              <button type="button" data-task-id={t.taskId} className="hx-chat__recent-task" onClick={() => onSelectTask(t.taskId)}>
                <span className="hx-chat__recent-label">{t.label}</span>
                <span className="hx-chat__recent-meta">{t.meta}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="hx-chat__thread">
        {messages.length === 0 ? (
          <p className="hx-chat__empty">No messages yet.</p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className="hx-msg" data-from={m.from}>
              <span className="hx-msg__who">{actorName[m.from]}</span>
              <p>{m.text}</p>
            </div>
          ))
        )}
        {work && work.steps > 0 && (
          <details className="hx-work">
            <summary>{workedForLabel(work)}</summary>
            <ul>{work.events.map((e) => <li key={e.id}>{e.text}{e.detail ? <span> · {e.detail}</span> : null}</li>)}</ul>
          </details>
        )}
        {pendingCriteria.map((criterion) => (
          <div key={`${criterion.criterionId}:${criterion.evidenceId}`} className="hx-msg hx-msg--criterion" data-from="halo" data-evidence-id={criterion.evidenceId}>
            <span className="hx-msg__who">Halo · Ready to finish</span>
            <p>{criterion.text.startsWith('originalRequest') ? `Does the result match what you asked for? “${taskLabel}”` : criterion.text}</p>
            <details className="hx-msg__more"><summary>Details</summary><code>Criterion {criterion.criterionId} · evidence {criterion.evidenceId}</code></details>
            <div className="hx-msg__actions">
              <button type="button" className="hx-btn hx-btn--secondary hx-btn--compact" aria-label={`Reject criterion ${criterion.criterionId}`} onClick={() => onConfirmCriterion(criterion, 'rejected')}>Reject</button>
              <button type="button" className="hx-btn hx-btn--primary hx-btn--compact" aria-label={`Confirm criterion ${criterion.criterionId}`} onClick={() => onConfirmCriterion(criterion, 'verified')}>Confirm</button>
            </div>
          </div>
        ))}
      </div>
      <form
        className="hx-chat__composer"
        onSubmit={(e) => {
          e.preventDefault()
          const text = nonEmptyVerbatim(value)
          if (text === null) return
          onSend(text)
          setValue('')
        }}
      >
        {tabContext && (
          <p className="hx-chat__ctx" title={`${tabContext.title} · ${tabContext.host}`}>
            <span className="hx-chat__ctx-t">{tabContext.title || tabContext.host}</span>
            {tabContext.title && <span className="hx-chat__ctx-h">{tabContext.host}</span>}
          </p>
        )}
        <div className="hx-chat__row">
          <ModelPicker settings={model.settings} onSelectModel={(id) => void model.selectModel(id)} onEffort={(effort) => void model.selectEffort(effort)} savingProvider={model.savingProvider} savingEffort={model.savingEffort} />
          <input
            className="hx-chat__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isTaskActive ? 'Describe a goal update…' : 'Describe a task…'}
            aria-label={isTaskActive ? 'Amend task goal' : 'What should the agent do?'}
            title={isTaskActive ? 'Sending this records a goal update; it is not a live conversation.' : 'Start a new task.'}
          />
          <button className="hx-chat__send" type="submit" aria-label="Send" title="Send" disabled={!value.trim()}>↑</button>
        </div>
      </form>
    </section>
  )
}
