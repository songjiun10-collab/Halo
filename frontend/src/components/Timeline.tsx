import { useEffect, useRef } from 'react'
import { AGENT } from '../session/session'
import type { Actor, Outcome, TimelineEvent } from '../session/types'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

/** The sentence already says what happened ("Blocked …", "Approved …"); only a pending ask gets a word. */
const outcomeText: Partial<Record<Outcome, string>> = { approval: 'Waiting' }

export function Timeline({ events, dim }: { events: TimelineEvent[]; dim: boolean }) {
  const endRef = useRef<HTMLLIElement>(null)
  // Keep the newest event in view as the timeline grows.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [events.length])
  return (
    <ol className="hx-timeline" aria-label="Activity" data-dim={dim || undefined}>
      {events.map((e, i) => {
        const word = e.outcome && outcomeText[e.outcome]
        return (
          <li
            key={e.id}
            className="hx-event"
            data-actor={e.actor}
            data-outcome={e.outcome}
            title={e.policy ? `Policy: ${e.policy}` : undefined}
            ref={i === events.length - 1 ? endRef : undefined}
          >
            <span className="hx-event__text">
              <span className="hx-event__actor">{actorName[e.actor]}</span> <span className="hx-event__what">{e.text}</span>
              {word && <span className="hx-event__outcome"> · {word}</span>}
            </span>
            {e.detail && <code className="hx-event__detail">{e.detail}</code>}
            {e.policy && <span className="hx-sr">Policy verdict: {e.policy}</span>}
          </li>
        )
      })}
    </ol>
  )
}
