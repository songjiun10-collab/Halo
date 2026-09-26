import type { TimelineEvent } from '../session/types'
import { HaloMark } from './Logo'

/** A Halo intervention that needs no answer: shown briefly under the address bar, then kept in Activity. */
/** `blocked`: a modal decision is open, so the notice is visible but not interactive. */
export function Notice({ event, leaving, blocked, onOpen }: { event: TimelineEvent; leaving?: boolean; blocked?: boolean; onOpen: () => void }) {
  return (
    <div className="hx-notice" role="note" data-outcome={event.outcome} data-leaving={leaving || undefined} inert={leaving || blocked}>
      <HaloMark className="hx-sheet__mark" />
      <span className="hx-notice__text">
        <b>Halo</b> {event.text.charAt(0).toLowerCase() + event.text.slice(1)}
        {event.detail && <> to <code>{event.detail}</code></>}
      </span>
      <button className="hx-notice__more" onClick={onOpen}>Details</button>
    </div>
  )
}
