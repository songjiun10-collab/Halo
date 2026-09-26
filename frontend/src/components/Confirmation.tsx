import { useEffect, useRef } from 'react'
import { AGENT } from '../session/session'
import type { Approval } from '../session/types'

interface Props {
  approval: Approval
  onApprove: () => void
  onDeny: () => void
}

/** The human confirmation: one question, the facts that decide it, two buttons. */
export function Confirmation({ approval, onApprove, onDeny }: Props) {
  const questionRef = useRef<HTMLParagraphElement>(null)
  // Focus the question, never the approve button: a stray Enter must not approve.
  useEffect(() => { questionRef.current?.focus() }, [approval])
  return (
    <section className="hx-confirm" aria-label={`${AGENT} needs your confirmation`} title={approval.request}>
      <p className="hx-confirm__question" tabIndex={-1} ref={questionRef}>
        {approval.action} for <b className="num">{approval.amount}</b>?
      </p>
      <p className="hx-confirm__facts">
        {approval.paymentMethod} · <span className="hx-confirm__dest">{approval.destination}</span>
      </p>
      <div className="hx-confirm__actions">
        <button className="hx-btn hx-btn--primary hx-btn--compact" onClick={onApprove}>Approve</button>
        <button className="hx-btn hx-btn--secondary hx-btn--compact" onClick={onDeny}>Deny</button>
      </div>
    </section>
  )
}
