import { agentLabel } from '../session/session'
import type { AgentState } from '../session/types'

/** Agent state as a dot plus words. The dot is never the only cue. */
export function AgentDot({ state }: { state: AgentState }) {
  return <span className="hx-dot" data-state={state} aria-hidden="true" />
}

export function AgentStatus({ state }: { state: AgentState }) {
  return (
    <span className="hx-status">
      <AgentDot state={state} />
      <span className="hx-status__label">{agentLabel[state]}</span>
    </span>
  )
}
