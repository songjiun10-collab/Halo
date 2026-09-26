import type { AgentState } from '../session/types'

export function AgentDot({ state }: { state: AgentState }) {
  const mod = state === 'idle' ? '' : ` hx-agent--${state}`
  return (
    <span className={`hx-agent${mod}`} aria-hidden="true">
      <span className="hx-agent__dot" />
    </span>
  )
}
