import type { TimelineEvent } from '../session/types'
import { HaloMark } from './Logo'

/** A Halo intervention that needs no answer: shown briefly under the address bar, then kept in Activity. */
export function Notice({ event, leaving, onOpen }: { event: TimelineEvent; leaving?: boolean; onOpen: () => void }) {
  return (
    <div className="hx-notice" data-outcome={event.outcome} data-leaving={leaving || undefined} inert={leaving}>
      <HaloMark className="hx-sheet__mark" />
      <span className="hx-notice__text">
        <b>Halo</b> {event.text.charAt(0).toLowerCase() + event.text.slice(1)}
        {event.detail && <> to <code>{event.detail}</code></>}
      </span>
      <button className="hx-notice__more" onClick={onOpen}>Details</button>
    </div>
  )
}
