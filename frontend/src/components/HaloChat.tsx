import { useEffect, useRef, useState } from 'react'
import { AGENT } from '../session/session'
import { nonEmptyVerbatim } from '../session/composer'
import type { Actor, ChatMessage, PendingCriterion } from '../session/types'
import { HaloMark } from './Logo'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

interface Props {
  taskLabel: string
  messages: ChatMessage[]
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
export function HaloChat({ taskLabel, messages, recentTasks = [], pendingCriteria = [], isTaskActive = false, leaving, onClose, onSend, onSelectTask, onNewTask, onConfirmCriterion }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [value, setValue] = useState('')
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

  return (
    <section id="hx-chat" className="hx-chat" data-leaving={leaving || undefined} inert={leaving} role="dialog" aria-label="Halo chat" tabIndex={-1} ref={ref}>
      <div className="hx-chat__head">
        <HaloMark className="hx-sheet__mark" />
        <p className="hx-chat__task">{taskLabel}</p>
        <button type="button" className="hx-btn hx-btn--secondary hx-btn--compact" aria-label="New task" onClick={onNewTask}>New task</button>
        <button className="hx-chat__close" onClick={onClose} aria-label="Close chat">×</button>
      </div>
      {recentTasks.length > 0 && (
        <ul className="hx-chat__recent">
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
        {pendingCriteria.map((criterion) => (
          <div key={`${criterion.criterionId}:${criterion.evidenceId}`} className="hx-msg hx-msg--criterion" data-from="halo" data-evidence-id={criterion.evidenceId}>
            <span className="hx-msg__who">Halo · Verification required</span>
            <p>{criterion.criterionId}: {criterion.text}</p>
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
        <input
          className="hx-chat__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isTaskActive ? 'Describe a goal update…' : 'Describe a task…'}
          aria-label={isTaskActive ? 'Amend task goal' : 'What should the agent do?'}
          title={isTaskActive ? 'Sending this records a goal update; it is not a live conversation.' : 'Start a new task.'}
        />
        <button className="hx-btn hx-btn--primary hx-btn--compact" type="submit" disabled={!value.trim()}>Send</button>
      </form>
    </section>
  )
}
