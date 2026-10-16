import type { LeaseView } from '../session/api'
import { leaseLabel } from '../session/lease-label'

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }


/** Live leases for the active task; clicking one takes it back. */
export function LeaseChip({ leases, now, agent, onRevoke }: { leases: LeaseView[]; now: number; agent: string; onRevoke: (id: string) => void }) {
  const live = leases.filter((l) => l.expiresAt > now)
  if (!live.length) return null
  return (
    <div className="hx-leases" role="group" aria-label="Lent permissions">
      {live.map((l) => (
        <button key={l.id} type="button" className="hx-lease" aria-label={`Revoke lease ${l.action} on ${host(l.origin)}`} onClick={() => onRevoke(l.id)}>
          <span className="hx-lease__dot" aria-hidden="true" />{leaseLabel(agent, l, now)}
        </button>
      ))}
    </div>
  )
}
