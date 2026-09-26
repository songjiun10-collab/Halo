import { useEffect, useRef } from 'react'
import { AGENT } from '../session/session'
import type { Actor, Outcome, TimelineEvent } from '../session/types'
import { Check, Close, Lock, Pause } from './Icons'
import { HaloMark } from './Logo'

const actorName: Record<Actor, string> = { claude: AGENT, you: 'You', halo: 'Halo' }

const outcomeText: Record<Outcome, string> = {
  done: 'Done',
  blocked: 'Blocked',
  approval: 'Needs approval',
  approved: 'Approved',
  denied: 'Denied',
}
const outcomeGlyph = { done: Check, blocked: Lock, approval: Pause, approved: Check, denied: Close } as const

function Avatar({ actor }: { actor: Actor }) {
  return (
    <span className="hx-avatar" data-actor={actor} aria-hidden="true">
      {actor === 'halo' ? <HaloMark className="hx-avatar__mark" /> : actor === 'you' ? 'Y' : AGENT[0]}
    </span>
  )
}

function OutcomeChip({ outcome, policy }: Pick<TimelineEvent, 'outcome' | 'policy'>) {
  if (!outcome) return null
  const Glyph = outcomeGlyph[outcome]
  return (
    <span className="hx-outcome" data-outcome={outcome}>
      <span className="hx-outcome__main"><Glyph />{outcomeText[outcome]}</span>
      {policy && <span className="hx-outcome__policy">{policy}</span>}
    </span>
  )
}

export function Timeline({ events, dim }: { events: TimelineEvent[]; dim: boolean }) {
  const endRef = useRef<HTMLLIElement>(null)
  // Keep the newest event in view as the timeline grows.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [events.length])
  return (
    <ol className="hx-timeline" aria-label="Activity" data-dim={dim || undefined}>
      {events.map((e, i) => (
        <li key={e.id} className="hx-event" data-actor={e.actor} ref={i === events.length - 1 ? endRef : undefined}>
          <Avatar actor={e.actor} />
          <span className="hx-event__body">
            <span className="hx-event__text"><b>{actorName[e.actor]}</b><span aria-hidden="true"> · </span><span className="hx-sr">: </span>{e.text}</span>
            {e.detail && <code className="hx-event__detail">{e.detail}</code>}
          </span>
          <OutcomeChip outcome={e.outcome} policy={e.policy} />
        </li>
      ))}
    </ol>
  )
}
