import { useEffect, useRef } from 'react'
import type { PlannedStep } from '../session/types'
import { VerdictBadge } from './VerdictBadge'

interface Props {
  step: PlannedStep & { n: number }
  disabled: boolean
  onApprove: () => void
  onDeny: () => void
}

export function ApprovalPrompt({ step, disabled, onApprove, onDeny }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  // Move focus to the title (not to Approve) so nothing is approved by a stray Enter.
  useEffect(() => { titleRef.current?.focus() }, [step.n])
  const p = step.prompt
  return (
    <section className="hx-prompt" role="alertdialog" aria-labelledby="hx-prompt-title" aria-describedby="hx-prompt-text">
      <div className="hx-prompt__kicker">
        <VerdictBadge verdict="review" />
        <span className="hx-ai-label">Agent · step {step.n}</span>
      </div>
      <h2 className="hx-prompt__title" id="hx-prompt-title" tabIndex={-1} ref={titleRef}>
        {p?.title ?? step.title}
      </h2>
      <p className="hx-prompt__text" id="hx-prompt-text">{p?.consequence ?? 'The agent needs your approval to continue.'}</p>
      <div className="hx-prompt__well">{p?.request ?? step.target}</div>
      <div className="hx-prompt__actions">
        <button className="hx-btn hx-btn--primary" onClick={onApprove} disabled={disabled}>Approve once</button>
        <button className="hx-btn hx-btn--danger" onClick={onDeny} disabled={disabled}>Deny</button>
      </div>
      {disabled && <p className="hx-prompt__text" style={{ marginTop: 12, marginBottom: 0 }}>Agent is stopped. Resume to answer.</p>}
    </section>
  )
}
