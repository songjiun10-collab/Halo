import { useEffect, useRef } from 'react'
import { AGENT } from '../session/session'
import type { Approval } from '../session/types'
import { HaloMark } from './Logo'

interface Props {
  approval: Approval
  leaving?: boolean
  onApprove: () => void
  onDeny: () => void
}

/**
 * Halo's interruption: a permission sheet dropped from the address bar, the one
 * place the pending decision is described. The amount leads; then how, then where.
 */
export function HaloSheet({ approval, leaving, onApprove, onDeny }: Props) {
  const ref = useRef<HTMLHeadingElement>(null)
  // Focus the question, never the approve button: a stray Enter must not approve.
  useEffect(() => { ref.current?.focus() }, [approval])
  return (
    <section className="hx-sheet" data-leaving={leaving || undefined} inert={leaving} role="alertdialog" aria-labelledby="hx-sheet-title" aria-describedby="hx-sheet-facts">
      <p className="hx-sheet__from"><HaloMark className="hx-sheet__mark" />Halo paused {AGENT} for your approval</p>
      <h2 className="hx-sheet__title" id="hx-sheet-title" tabIndex={-1} ref={ref}>
        {approval.action}
        <span className="hx-sheet__amount num">{approval.amount}</span>
      </h2>
      <dl className="hx-sheet__facts" id="hx-sheet-facts">
        <div><dt>Pay with</dt><dd>{approval.paymentMethod}</dd></div>
        <div><dt>To</dt><dd className="hx-sheet__dest">{approval.destination}</dd></div>
      </dl>
      <div className="hx-sheet__actions">
        <button className="hx-btn hx-btn--secondary" onClick={onDeny}>Deny</button>
        <button className="hx-btn hx-btn--primary" onClick={onApprove}>Approve {approval.amount}</button>
      </div>
      <code className="hx-sheet__request" title="Exact request">{approval.request}</code>
    </section>
  )
}
