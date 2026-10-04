import { useEffect, useRef, useState } from 'react'
import { AGENT } from '../session/session'
import type { Approval } from '../session/types'
import { HaloMark } from './Logo'

interface Props {
  approval: Approval
  leaving?: boolean
  onApprove: () => void
  onDeny: () => void
  /** You'd rather do it yourself: the ask is set aside and you get control. */
  onTakeOver: () => void
  /** Lend the capability for a short, bounded time instead of allowing once. */
  onLend?: (terms: { minutes: number; uses: number }) => void
}

const host = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
/** Identity of the pending decision: derive() rebuilds the object each update, so state resets key on this, not the object. */
export const approvalKey = (a: { taskId: string; id: string }) => `${a.taskId}:${a.id}`
export const lendSummary = (offer: { action: string; origin: string }, t: { minutes: number; uses: number }) =>
  `${offer.action} · ${host(offer.origin)} · ${t.minutes} min · ${t.uses} ${t.uses === 1 ? 'use' : 'uses'}`

/**
 * Halo's interruption: a permission sheet dropped from the address bar, the one
 * place the pending decision is described.
 */
export function HaloSheet({ approval, leaving, onApprove, onDeny, onTakeOver, onLend }: Props) {
  const ref = useRef<HTMLHeadingElement>(null)
  // Focus the question, never the approve button: a stray Enter must not approve.
  const [lending, setLending] = useState(false)
  const [terms, setTerms] = useState({ minutes: 10, uses: 3 })
  useEffect(() => { ref.current?.focus(); setLending(false); setTerms({ minutes: 10, uses: 3 }) }, [approval.id, approval.taskId])
  const offer = approval.leaseOffer
  return (
    <section className="hx-sheet" data-approval-id={approval.id} data-leaving={leaving || undefined} inert={leaving} role="alertdialog" aria-modal="true" aria-labelledby="hx-sheet-title" aria-describedby="hx-sheet-request">
      <p className="hx-sheet__from"><HaloMark className="hx-sheet__mark" />Halo paused {AGENT} for your approval</p>
      <h2 className="hx-sheet__title" id="hx-sheet-title" tabIndex={-1} ref={ref}>{approval.action}</h2>
      {approval.widen && <p className="hx-sheet__widen">This is outside the current permission mode.</p>}
      {lending && offer && (
        <div className="hx-sheet__lend">
          <label>Minutes <input type="range" min={1} max={10} value={terms.minutes} aria-valuetext={`${terms.minutes} min`} onChange={(e) => setTerms({ ...terms, minutes: Number(e.target.value) })} /></label>
          <label>Uses <input type="range" min={1} max={3} value={terms.uses} aria-valuetext={`${terms.uses} ${terms.uses === 1 ? 'use' : 'uses'}`} onChange={(e) => setTerms({ ...terms, uses: Number(e.target.value) })} /></label>
          <p className="hx-sheet__lend-summary">{lendSummary(offer, terms)}</p>
        </div>
      )}
      <div className="hx-sheet__actions">
        <button className="hx-sheet__takeover" onClick={onTakeOver}>Take over</button>
        <button className="hx-btn hx-btn--secondary" onClick={onDeny}>Deny</button>
        {offer && onLend && (lending
          ? <button className="hx-btn hx-btn--secondary" onClick={() => onLend(terms)}>Lend</button>
          : <button className="hx-btn hx-btn--secondary" onClick={() => setLending(true)}>Lend…</button>)}
        <button className="hx-btn hx-btn--primary" onClick={onApprove}>Allow once</button>
      </div>
      <code className="hx-sheet__request" id="hx-sheet-request" title="Exact request">{approval.request}</code>
    </section>
  )
}
