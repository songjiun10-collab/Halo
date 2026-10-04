import type { OwnerRef } from './agent-api'

/** What the workspace sidebar asks the agent home to show. */
export type AgentNavView = { n: 'hub' } | { n: 'detail'; owner: OwnerRef }

// One pending request: the home screen may mount after the click (the sidebar
// first leaves the current task or page), so it takes the request on mount.
let pending: AgentNavView | null = null
const listeners = new Set<(view: AgentNavView) => void>()

export function openAgentView(view: AgentNavView) {
  pending = view
  for (const listener of listeners) listener(view)
}

export function takeAgentView(): AgentNavView | null {
  const view = pending
  pending = null
  return view
}

/** The home screen's starting mode: a pending sidebar request opens it in Agent mode. */
export const homeModeFor = (last: 'task' | 'agent'): 'task' | 'agent' => pending !== null ? 'agent' : last

export function onAgentView(callback: (view: AgentNavView) => void) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}
