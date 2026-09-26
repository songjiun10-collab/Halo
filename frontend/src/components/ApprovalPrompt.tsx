import { useEffect, useRef } from 'react'
import type { PlannedStep } from '../session/types'
import { VerdictBadge } from './VerdictBadge'

interface Props {
  step: PlannedStep & { n: number }
  paused: boolean
  onApprove: () => void
  onDeny: () => void
}

export function ApprovalPrompt({ step, paused, onApprove, onDeny }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  // Focus the question, never the approve button: a stray Enter must not approve.
  useEffect(() => { titleRef.current?.focus() }, [step.n])
  const p = step.prompt
  return (
    <section className="hx-prompt" aria-labelledby="hx-prompt-title" aria-describedby="hx-prompt-text">
      <div className="hx-prompt__kicker">
        <VerdictBadge verdict="review" />
        <span className="hx-meta">Agent · step {step.n}</span>
      </div>
      <h3 className="hx-prompt__title" id="hx-prompt-title" tabIndex={-1} ref={titleRef}>{p?.title ?? step.title}</h3>
      <p className="hx-prompt__text" id="hx-prompt-text">{p?.consequence ?? 'The agent needs your approval to continue.'}</p>
      <code className="hx-prompt__request">{p?.request ?? step.target}</code>
      {paused ? (
        <p className="hx-prompt__note">The agent is paused. Resume it to answer.</p>
      ) : (
        <div className="hx-prompt__actions">
          <button className="hx-btn hx-btn--primary" onClick={onApprove}>{p?.approveLabel ?? 'Allow once'}</button>
          <button className="hx-btn hx-btn--secondary" onClick={onDeny}>Deny</button>
        </div>
      )}
    </section>
  )
}
