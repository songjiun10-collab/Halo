import { useEffect, useRef, useState } from 'react'
import { AGENT } from '../session/session'
import type { Actor, SessionState } from '../session/types'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

interface Props {
  session: SessionState
  onClose: () => void
}

/**
 * What happened, on request. Only events that matter to a person are listed;
 * the agent's step-by-step trace stays folded under "All steps".
 */
export function Activity({ session, onClose }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    const el = ref.current
    el?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const notable = session.timeline.filter((e) => e.notable)
  const steps = session.timeline
  return (
    <section id="hx-activity" className="hx-activity" role="dialog" aria-label="Halo events" tabIndex={-1} ref={ref}>
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
