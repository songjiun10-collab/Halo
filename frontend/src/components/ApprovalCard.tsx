import { useEffect, useRef } from 'react'
import { AGENT } from '../session/session'
import type { Approval } from '../session/types'

interface Props {
  approval: Approval
  onApprove: () => void
  onDeny: () => void
}

/** The one decision in the panel: amount first, then how you pay, then where it goes. */
export function ApprovalCard({ approval, onApprove, onDeny }: Props) {
  const amountRef = useRef<HTMLParagraphElement>(null)
  // Focus the question, never the approve button: a stray Enter must not approve.
  useEffect(() => { amountRef.current?.focus() }, [approval])
  return (
    <section className="hx-approval" aria-labelledby="hx-approval-title" aria-describedby="hx-approval-amount hx-approval-facts">
      <p className="hx-approval__kicker">
        <span>Needs approval</span>
        <span className="hx-approval__policy">review</span>
      </p>
      <h3 className="hx-approval__title" id="hx-approval-title">{AGENT} wants to {approval.action.toLowerCase()}</h3>
      <p className="hx-approval__amount num" id="hx-approval-amount" tabIndex={-1} ref={amountRef}>{approval.amount}</p>
      <dl className="hx-approval__facts" id="hx-approval-facts">
        <div><dt>Pay with</dt><dd>{approval.paymentMethod}</dd></div>
        <div><dt>To</dt><dd className="hx-approval__dest">{approval.destination}</dd></div>
      </dl>
      <code className="hx-approval__request">{approval.request}</code>
      <div className="hx-approval__actions">
        <button className="hx-btn hx-btn--primary" onClick={onApprove}>Approve {approval.amount}</button>
        <button className="hx-btn hx-btn--secondary" onClick={onDeny}>Deny</button>
      </div>
    </section>
  )
}
