import { AGENT, AGENT_ROLE, controlLabel } from '../session/session'
import type { Control } from '../session/types'

interface Props {
  control: Control
  finished: boolean
  onTakeOver: () => void
  onResume: () => void
}

/**
 * Who is driving this tab, as part of the address field (like a site-permission
 * icon), not a separate control bar. One click hands control over.
 */
export function ControllerChip({ control, finished, onTakeOver, onResume }: Props) {
  if (control === 'you' && finished) return null
  if (control === 'you') {
    return (
      <button className="hx-chip" data-control="you" onClick={onResume} title={`Let ${AGENT} continue the task`}>
        <span className="hx-chip__dot" aria-hidden="true" />Resume {AGENT_ROLE.toLowerCase()}
      </button>
    )
  }
  return (
    <button className="hx-chip" data-control={control} onClick={onTakeOver} title={`${AGENT} is driving this tab. Take over to continue yourself.`}>
      <span className="hx-chip__dot" aria-hidden="true" />
      <span className="hx-chip__state">{controlLabel[control]}</span>
      <span className="hx-chip__action">Take over</span>
    </button>
  )
}
