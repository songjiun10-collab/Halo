import type { BrowserSnapshot, GoalSpec, JournalEvent, PageDialogInfo, TaskSnapshot, TaskSummary } from './api'
import type { ChildPlanSummary } from './child-agents'

export type Verdict = 'allow' | 'review' | 'deny' | 'quarantine'
export type Control = 'claude' | 'approval' | 'you'
export type TabActivity = 'working' | 'waiting' | 'paused' | 'done'
export type Actor = 'claude' | 'you' | 'halo'
export type Outcome = 'done' | 'blocked' | 'approval' | 'approved' | 'denied'
export interface Tab {
  id: string
  history: string[]
  index: number
  titles?: Record<string, string>
  claude?: TabActivity
  canGoBack: boolean
  canGoForward: boolean
  /** The page is still loading (direct tabs only). */
  loading?: boolean
  /** Browser zoom as a factor, 1 = 100% (direct tabs only). */
  zoom?: number
  /** A page dialog waiting for the person (direct tabs only). */
  dialog?: PageDialogInfo | null
}
export interface TimelineEvent { id: number; actor: Actor; text: string; detail?: string; outcome?: Outcome; policy?: Verdict; notable?: boolean; at?: string }
export interface Approval { taskId: string; id: string; action: string; request: string; createdAt: string; widen: boolean; leaseOffer: { action: string; origin: string } | null }
export interface ChatMessage { from: Actor; text: string }
export interface PendingCriterion { taskId: string; criterionId: string; text: string; goalVersion: number; evidenceId: string }
export interface SessionState {
  connected: boolean
  activeTaskId: string | null
  tasks: TaskSummary[]
  goal: GoalSpec | null
  snapshot: TaskSnapshot | null
  browser: BrowserSnapshot | null
  directBrowser: boolean
  recoveryReason: string | null
  childPlan: ChildPlanSummary | null
  task: string
  control: Control
  finished: boolean
  tabs: Tab[]
  activeTabId: string
  timeline: TimelineEvent[]
  journal: JournalEvent[]
  approval?: Approval
  messages: ChatMessage[]
  loading: boolean
  busy: string | null
  error: string | null
}
