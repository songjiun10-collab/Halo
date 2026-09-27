import { useEffect, useRef } from 'react'
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
}

/**
 * Halo's interruption: a permission sheet dropped from the address bar, the one
 * place the pending decision is described.
 */
export function HaloSheet({ approval, leaving, onApprove, onDeny, onTakeOver }: Props) {
  const ref = useRef<HTMLHeadingElement>(null)
  // Focus the question, never the approve button: a stray Enter must not approve.
  useEffect(() => { ref.current?.focus() }, [approval])
  return (
    <section className="hx-sheet" data-leaving={leaving || undefined} inert={leaving} role="alertdialog" aria-modal="true" aria-labelledby="hx-sheet-title" aria-describedby="hx-sheet-request">
      <p className="hx-sheet__from"><HaloMark className="hx-sheet__mark" />Halo paused {AGENT} for your approval</p>
      <h2 className="hx-sheet__title" id="hx-sheet-title" tabIndex={-1} ref={ref}>{approval.action}</h2>
      <div className="hx-sheet__actions">
        <button className="hx-sheet__takeover" onClick={onTakeOver}>Take over</button>
        <button className="hx-btn hx-btn--secondary" onClick={onDeny}>Deny</button>
        <button className="hx-btn hx-btn--primary" onClick={onApprove}>Allow once</button>
      </div>
      <code className="hx-sheet__request" id="hx-sheet-request" title="Exact request">{approval.request}</code>
    </section>
  )
}
