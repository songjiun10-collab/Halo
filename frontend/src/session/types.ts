/** Gateway verdicts, matching `Decision` in halo/policy.py. Shown as secondary text only. */
export type Verdict = 'allow' | 'review' | 'deny' | 'quarantine'

/** Who drives the browser right now. */
export type Control = 'claude' | 'approval' | 'you'

/** Claude's state in one tab, shown next to its favicon. */
export type TabActivity = 'working' | 'waiting' | 'paused' | 'done'

export type Actor = 'claude' | 'you' | 'halo'

/** What happened, in words a person uses. The policy verdict rides along as detail. */
export type Outcome = 'done' | 'blocked' | 'approval' | 'approved' | 'denied'

export interface Tab {
  id: string
  /** Visited URLs, oldest first; `index` points at the current one. */
  history: string[]
  index: number
  /** Set once Claude has worked in this tab. */
  claude?: TabActivity
}

export interface TimelineEvent {
  id: number
  actor: Actor
  text: string
  /** Secondary line: selector, host, or request. */
  detail?: string
  outcome?: Outcome
  policy?: Verdict
}

export interface Approval {
  /** "Place order" — what Claude wants to do. */
  action: string
  /** Timeline text once it has run: "Placed the order". */
  doneText: string
  amount: string
  paymentMethod: string
  destination: string
  request: string
}

/** One scripted step of Claude's plan with the gateway's verdict for it. */
export interface PlannedStep {
  /** Which tab it runs in: a demo tab key. */
  tab: string
  /** Past tense once it runs ("Filled shipping address"); for review steps, the ask ("Wants to place order"). */
  text: string
  target: string
  verdict: Verdict
  /** When Halo stops a step, Halo says what it did ("Blocked a tracking request"). */
  haloText?: string
  approval?: Approval
  /** URL this step opens in its tab. */
  navigatesTo?: string
  /** Title of the tab this step opens in the background, if it creates one. */
  opensTab?: string
}

export interface SessionState {
  task: string
  control: Control
  /** Claude has no steps left. */
  finished: boolean
  tabs: Tab[]
  /** Demo tab keys to tab ids, for scripted steps. */
  tabKeys: Record<string, string>
  activeTabId: string
  timeline: TimelineEvent[]
  plan: PlannedStep[]
  /** The step waiting on your approval. */
  pending?: PlannedStep
}
