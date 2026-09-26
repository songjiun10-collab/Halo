import { useEffect, useRef, useState } from 'react'
import { AGENT } from '../session/session'
import type { Actor, SessionState } from '../session/types'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

interface Props {
  session: SessionState
  leaving?: boolean
  onClose: () => void
}

/**
 * What happened, on request. Only events that matter to a person are listed;
 * the agent's step-by-step trace stays folded under "All steps".
 */
export function Activity({ session, leaving, onClose }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [showAll, setShowAll] = useState(false)
  // Remember what opened Activity so focus can go back there when it closes.
  const opener = useRef<HTMLElement | null>(null)
  // Runs on open and again if it's reopened while still animating out.
  useEffect(() => {
    const el = ref.current
    if (leaving) {
      // Only move focus if it was inside (or has already fallen to the page body).
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaving, onClose])

  const notable = session.timeline.filter((e) => e.notable)
  const steps = session.timeline
  return (
    <section id="hx-activity" className="hx-activity" data-leaving={leaving || undefined} inert={leaving} role="dialog" aria-label="Halo events" tabIndex={-1} ref={ref}>
      <p className="hx-activity__task">{session.task}<span className="hx-demo">Demo</span></p>
      {notable.length === 0 ? (
        <p className="hx-activity__empty">Nothing needed you so far.</p>
      ) : (
        <ol className="hx-events">
          {notable.map((e) => (
            <li key={e.id} className="hx-ev" data-actor={e.actor} data-outcome={e.outcome} title={e.policy ? `Policy: ${e.policy}` : undefined}>
              <span><span className="hx-ev__actor">{actorName[e.actor]}</span> <span className="hx-ev__what">{e.text}</span></span>
              {e.detail && <code className="hx-ev__detail">{e.detail}</code>}
              {e.policy && <span className="hx-sr">Policy verdict: {e.policy}</span>}
            </li>
          ))}
        </ol>
      )}
      <button className="hx-activity__toggle" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
        {showAll ? 'Hide steps' : `All steps (${steps.length})`}
      </button>
      {showAll && (
        <ol className="hx-steps">
          {steps.map((e) => (
            <li key={e.id} title={e.policy ? `Policy: ${e.policy}` : undefined}>
              <span><span className="hx-ev__actor">{actorName[e.actor]}</span> {e.text}</span>
              {e.detail && <code className="hx-ev__detail">{e.detail}</code>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
