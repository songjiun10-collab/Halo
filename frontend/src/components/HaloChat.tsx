import { useEffect, useRef, useState } from 'react'
import { AGENT } from '../session/session'
import type { Actor, ChatMessage } from '../session/types'
import { HaloMark } from './Logo'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

interface Props {
  taskLabel: string
  messages: ChatMessage[]
  recentTasks?: { label: string; meta: string }[]
  leaving?: boolean
  onClose: () => void
  onSend: (text: string) => void
}

/**
 * Halo's own surface for talking to the agent, reached from the halo ring.
 * Same focus-management contract as Activity: opens focused, restores focus
 * to whatever opened it (or the ring) on close, closes on Escape.
 */
export function HaloChat({ taskLabel, messages, recentTasks = [], leaving, onClose, onSend }: Props) {
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
        <button className="hx-chat__close" onClick={onClose} aria-label="Close chat">×</button>
      </div>
      {recentTasks.length > 0 && (
        <ul className="hx-chat__recent">
          {recentTasks.map((t, i) => (
            <li key={i}>
              <span className="hx-chat__recent-label">{t.label}</span>
              <span className="hx-chat__recent-meta">{t.meta}</span>
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
      </div>
      <form
        className="hx-chat__composer"
        onSubmit={(e) => {
          e.preventDefault()
          const text = value.trim()
          if (!text) return
          onSend(text)
          setValue('')
        }}
      >
        <input
          className="hx-chat__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Message the agent…"
          aria-label="Message the agent"
        />
        <button className="hx-btn hx-btn--primary hx-btn--compact" type="submit" disabled={!value.trim()}>Send</button>
      </form>
    </section>
  )
}
