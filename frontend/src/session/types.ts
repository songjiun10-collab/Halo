/** Gateway verdicts, matching `Decision` in halo/policy.py. */
export type Verdict = 'allow' | 'review' | 'deny' | 'quarantine'

export type AgentState = 'idle' | 'acting' | 'waiting' | 'stopped'

export interface Tab {
  id: string
  title: string
  url: string
  /** True while the agent is working in this tab. */
  agent: boolean
}

export interface Step {
  n: number
  /** Human-readable action, e.g. "Click “Place order”". */
  title: string
  /** Exact machine target: selector or request line. */
  target: string
  verdict: Verdict
  /** Set once a person has answered a `review` step. */
  resolution?: 'approved' | 'denied'
}

/** A step the agent wants to take, with the gateway's verdict for it. */
export interface PlannedStep {
  title: string
  target: string
  verdict: Verdict
  /** For `review` steps: what the ApprovalPrompt tells the person. */
  prompt?: { title: string; consequence: string; request: string }
  /** Tab URL after the step runs, if it navigates. */
  navigatesTo?: { url: string; title: string }
}

export interface SessionState {
  task: string
  agent: AgentState
  tabs: Tab[]
  activeTabId: string
  log: Step[]
  plan: PlannedStep[]
  /** The step waiting on the person, if any. */
  pending?: PlannedStep & { n: number }
  lastUpdate: number
}
