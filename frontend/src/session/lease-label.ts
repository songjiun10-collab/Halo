import type { LeaseView } from './api'
import { host } from './session'

export function leaseLabel(agent: string, lease: LeaseView, now: number) {
  const minutes = Math.max(1, Math.ceil((lease.expiresAt - now) / 60_000))
  return `${agent} borrowed: ${lease.action} · ${host(lease.origin)} · ${minutes} min · ${lease.usesLeft} left`
}
