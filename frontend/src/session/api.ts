import type { BackgroundRuntimeSnapshot, MemoryPolicy } from './background-runtime'
import type { ChildPlanSummary } from './child-agents'

/** Renderer view of the existing harness contracts and trusted preload methods. */
export type TaskState = 'idle' | 'running' | 'awaiting_approval' | 'awaiting_verification' | 'paused' | 'stopped' | 'completed'
export interface GoalCriterion { id: string; text: string; required: boolean; verification: 'host' | 'user'; sourceMessageId?: string }
export interface GoalConstraint { id: string; text: string; sourceMessageId?: string }
export type LockRule = { kind: 'deny_action'; action: 'navigate' | 'follow_link' | 'click' | 'type' | 'submit_form' } | { kind: 'allow_origins' | 'deny_origins'; origins: string[] }
export interface IntentLockInput { rules: LockRule[] }
export interface LeaseOffer { action: string; origin: string }
export interface LeaseView { id: string; action: string; origin: string; expiresAt: number; usesLeft: number }
export interface GoalSpec {
  schemaVersion: number
  taskId: string
  goalVersion: number
  originalRequest: string
  amendments: { id: string; text: string; at: string; supersedesConstraintIds: string[]; authority: 'user' }[]
  constraints: GoalConstraint[]
  criteria: GoalCriterion[]
  limits: { maxActions: number; maxPlannerCalls: number; maxActiveMs: number }
  createdAt: string
  lock?: { rules: LockRule[]; digest: string }
}
export interface GoalInput { lock?: IntentLockInput; originalRequest: string; constraints?: GoalConstraint[]; criteria?: GoalCriterion[]; limits?: Partial<GoalSpec['limits']> }
export interface AmendmentInput { text: string; supersedesConstraintIds: string[]; newConstraints: GoalConstraint[]; newCriteria: GoalCriterion[] }
export interface CriterionStatus { criterionId: string; status: 'pending' | 'verified' | 'rejected'; evidenceId: string; goalVersion: number }
export interface CriterionConfirmation { criterionId: string; goalVersion: number; evidenceId: string; outcome: 'verified' | 'rejected' }
export interface ApprovalRequest { id: string; summary: string; action: string; createdAt: string; widen?: boolean; leaseOffer?: LeaseOffer | null }
export interface TaskSnapshot {
  leases?: LeaseView[]
  state: TaskState
  pauseReason: string | null
  goalVersion: number
  budgets: Record<string, number>
  segment: Record<string, unknown>
  criteriaStatus: CriterionStatus[]
  approvalQueue: ApprovalRequest[]
}
export interface TaskSummary { taskId: string; originalRequest: string; state: TaskState; pauseReason: string | null; active: boolean; /** 1-based FIFO position while waiting for admission. */ queuePosition?: number }
export interface TaskDetail { taskId: string; goal: GoalSpec; snapshot?: TaskSnapshot; active: boolean; recoveryReason?: string }
export interface BrowserSnapshot {
  tabs: { id: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean }[]
  activeTabId: string | null
  documentEpoch: number
}
export interface TaskEvent { taskId: string; snapshot: TaskSnapshot; goal?: GoalSpec; browser?: BrowserSnapshot; childPlan?: ChildPlanSummary | null }
export interface JournalEvent {
  seq: number
  eventId: string
  taskId: string
  goalVersion: number
  type: 'goal_created' | 'goal_amended' | 'action_started' | 'action_outcome' | 'evidence_recorded' | 'approval_cancelled' | 'note'
  payload: Record<string, unknown>
  at: string
}
export interface BrowserViewport { x: number; y: number; width: number; height: number; visible: boolean }
export interface BrowserAction { type: 'navigate' | 'back' | 'forward'; url?: string }
export interface DirectBrowserSnapshot {
  page: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; hasPage?: boolean }
  tabs: { id: string; url: string; title: string }[]
  activeTabId: string
  task: { id?: string | null; state?: string }
  approvalQueue: unknown[]
  timeline: unknown[]
}
export interface HostSettings {
  version: number
  executionMode: 'sequential' | 'parallel'
  permissionMode: 'observe' | 'browse' | 'interact' | 'full'
  plannerEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  memoryPolicy: 'budgeted' | 'user_override'
  plannerProvider: 'none' | 'claude_code' | 'codex_cli' | 'antigravity' | 'cursor' | 'nvidia' | 'opencode_cli'
  /** Allowlisted planner model id; unset runs the provider's default model. */
  plannerModel?: string
  /** Opt-in faster planner tier; unset is off. */
  plannerFast?: boolean
}
export interface HaloBrowserApi {
  getSnapshot: () => Promise<DirectBrowserSnapshot>
  navigate: (url: string) => Promise<DirectBrowserSnapshot>
  goBack: () => Promise<DirectBrowserSnapshot>
  goForward: () => Promise<DirectBrowserSnapshot>
  reload: () => Promise<DirectBrowserSnapshot>
  newTab: () => Promise<DirectBrowserSnapshot>
  selectTab: (tabId: string) => Promise<DirectBrowserSnapshot>
  closeTab: (tabId: string) => Promise<DirectBrowserSnapshot>
  newWindow: () => Promise<{ opened: boolean }>
  /** Optional: older hosts lack it. */
  captureSurface?: () => Promise<string | null>
  setBrowserBounds: (bounds: BrowserViewport) => Promise<unknown>
  onEvent: (callback: (event: { snapshot: DirectBrowserSnapshot }) => void) => () => void
  createTask(input: GoalInput): Promise<{ taskId: string; snapshot: TaskSnapshot; goal: GoalSpec }>
  listTasks(): Promise<TaskSummary[]>
  getTaskDetail(taskId: string): Promise<TaskDetail>
  resumeSavedTask(taskId: string, opts?: { confirmed?: boolean }): Promise<TaskSnapshot>
  amendTask(taskId: string, input: AmendmentInput): Promise<TaskSnapshot>
  confirmCriterion(taskId: string, input: CriterionConfirmation): Promise<TaskSnapshot>
  taskApprove(taskId: string, approvalId: string): Promise<TaskSnapshot>
  taskDeny(taskId: string, approvalId: string): Promise<TaskSnapshot>
  taskLend(taskId: string, requestId: string, terms: { minutes: number; uses: number }): Promise<TaskSnapshot>
  taskRevokeLease(taskId: string, leaseId: string): Promise<TaskSnapshot>
  taskPause(taskId: string): Promise<TaskSnapshot>
  taskStop(taskId: string): Promise<TaskSnapshot>
  taskTakeOver(taskId: string): Promise<TaskSnapshot>
  getTaskEvents(taskId: string, options?: { since?: number }): Promise<JournalEvent[]>
  getTaskBrowser(taskId: string): Promise<BrowserSnapshot>
  getChildPlan(taskId: string): Promise<ChildPlanSummary | null>
  getHostSettings(): Promise<HostSettings>
  updateHostSettings(patch: Partial<Omit<HostSettings, 'version'>>): Promise<HostSettings>
  taskBrowserAction(taskId: string, action: BrowserAction): Promise<BrowserSnapshot>
  setTaskViewport(taskId: string | null, viewport: BrowserViewport): Promise<unknown>
  onTaskEvent(callback: (event: TaskEvent) => void): () => void
  getBackgroundRuntimeSnapshot(): Promise<BackgroundRuntimeSnapshot>
  attachBackgroundRuntime(): Promise<BackgroundRuntimeSnapshot>
  detachBackgroundRuntime(): Promise<void>
  setMemoryPolicy(mode: MemoryPolicy): Promise<BackgroundRuntimeSnapshot>
  stopBackgroundService(): Promise<BackgroundRuntimeSnapshot>
  setBackgroundLaunchAtLogin?(enabled: boolean): Promise<BackgroundRuntimeSnapshot>
  onBackgroundRuntimeEvent(callback: (snapshot: BackgroundRuntimeSnapshot) => void): () => void
}
declare global { interface Window { haloBrowser?: HaloBrowserApi } }
