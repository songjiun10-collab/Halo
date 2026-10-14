import type { BackgroundRuntimeSnapshot, MemoryPolicy } from './background-runtime'
import type { ChildPlanSummary } from './child-agents'

/** Renderer view of the existing harness contracts and trusted preload methods. */
export type TaskState = 'idle' | 'queued' | 'running' | 'awaiting_approval' | 'awaiting_verification' | 'paused' | 'stopped' | 'completed'
export type TaskInput =
  | { type: 'insertText'; text: string }
  | { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; nx: number; ny: number; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[] }
  | { type: 'mouseWheel'; nx: number; ny: number; deltaX: number; deltaY: number; modifiers?: string[] }
  | { type: 'keyDown' | 'keyUp'; key: string; modifiers?: string[] }

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
  /** The agent's question when it paused with need_user. */
  needUserReason?: string
  goalVersion: number
  budgets: Record<string, number>
  segment: Record<string, unknown>
  criteriaStatus: CriterionStatus[]
  approvalQueue: ApprovalRequest[]
  /** Steps that ran without asking the user (approver-only or lease). */
  autoHandled?: number
  /** Read-only side reads running or finished while an approval waits. Findings stay host-side. */
  branches?: TaskBranchSummary[]
}
export interface TaskSummary { taskId: string; originalRequest: string; state: TaskState; pauseReason: string | null; active: boolean; /** 1-based FIFO position while waiting for admission. */ queuePosition?: number; /** Why a queued task has not started (an internal code; show it with waitReasonLabel). */ waitReason?: string | null }
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
/** A page dialog waiting for the person; `origin` is the host's reading of the tab, never the page's words. */
export interface PageDialogInfo { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt: string; origin: string }
export interface DirectBrowserSnapshot {
  page: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; hasPage?: boolean; loadState?: 'idle' | 'loading' | 'ready' | 'error'; zoom?: number; dialog?: PageDialogInfo | null }
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
  plannerEscalation?: boolean
  plannerRouting?: boolean
  /** Opt-in local journal of pages the user read, recalled by later tasks. */
  contextAwareness?: boolean
  /** Opt-in local, Luna-only strategy-learning journal. */
  strategyLearning?: boolean
  /** Payments are opt-in: only true lets the host act on a clear chat order to pay. Unset is off. */
  paymentsEnabled?: boolean
  /** Read-only, present only on a beta build with an expiry date. Never sent back in a patch. */
  buildExpiry?: { expired: boolean; daysLeft: number | null; expiresAt: number | null }
}
export interface HaloBrowserApi {
  readonly runtime?: 'chromium'
  getSnapshot: () => Promise<DirectBrowserSnapshot>
  navigate: (url: string) => Promise<DirectBrowserSnapshot>
  goBack: () => Promise<DirectBrowserSnapshot>
  goForward: () => Promise<DirectBrowserSnapshot>
  reload: () => Promise<DirectBrowserSnapshot>
  /** Optional: older hosts lack the next four. */
  stopLoading?: () => Promise<DirectBrowserSnapshot>
  zoom?: (action: 'in' | 'out' | 'reset') => Promise<DirectBrowserSnapshot>
  findInPage?: (query: string, options?: { backwards?: boolean }) => Promise<{ found: boolean; count: number }>
  clearFind?: () => Promise<boolean>
  /** The person's answer to the page dialog on the tab in front. Optional: older hosts lack it. */
  answerDialog?: (accept: boolean, text?: string) => Promise<DirectBrowserSnapshot>
  newTab: () => Promise<DirectBrowserSnapshot>
  selectTab: (tabId: string) => Promise<DirectBrowserSnapshot>
  closeTab: (tabId: string) => Promise<DirectBrowserSnapshot>
  newWindow: () => Promise<{ opened: boolean }>
  /** Optional: older hosts lack it. */
  captureSurface?: () => Promise<string | null>
  /** Chromium runtime: push live JPEG frames of the showing page (false when the engine cannot stream). */
  startSurfaceStream?: () => Promise<boolean>
  stopSurfaceStream?: () => Promise<boolean>
  onSurfaceFrame?: (callback: (payload: { frame: string }) => void) => () => void
  captureAgentFrame?: (taskId: string) => Promise<string | null>
  /** Attached UIs only: their task page lives in the service process, so it arrives as stills and goes back as input. */
  captureTaskFrame?: (taskId: string) => Promise<string | null>
  sendTaskInput?: (taskId: string, input: TaskInput) => Promise<boolean>
  sendSurfaceInput?: (input: TaskInput) => Promise<boolean>
  /** Optional: older hosts lack it. */
  copyText?: (text: string) => Promise<boolean>
  /** Voice input (whisper.cpp on this computer). Optional: older hosts and machines without the program lack it. */
  voiceAvailable?: () => Promise<boolean>
  transcribeAudio?: (wav: ArrayBuffer, options?: { language?: string }) => Promise<{ text: string }>
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
  clearActivity?(): Promise<boolean>
  getStrategyLearningState?(): Promise<{ enabled: boolean; activeRevisionId: string | null; candidates: any[]; revisions: any[] }>
  evaluateStrategyCandidate?(candidateId: string): Promise<unknown>
  promoteStrategyCandidate?(candidateId: string, expectedActiveRevisionId: string | null): Promise<unknown>
  rollbackStrategyGuidance?(targetRevisionId: string, expectedActiveRevisionId: string | null): Promise<unknown>
  clearStrategyLearning?(): Promise<boolean>
  /** Planner API keys registered in Settings; the key itself never comes back. */
  getApiKeyStatus?(): Promise<Record<string, boolean>>
  setApiKey?(provider: string, key: string): Promise<Record<string, boolean>>
  clearApiKey?(provider: string): Promise<Record<string, boolean>>
  refreshPlannerModels(): Promise<{ nvidia: { id: string; label: string; discovered: boolean }[]; error: string | null }>
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

export interface TaskBranchSummary {
  id: string
  approvalId: string
  state: 'running' | 'done' | 'failed' | 'aborted' | 'merged' | 'discarded'
  steps: { url: string; purpose: string }[]
  findings: number
  startedAt: number
}
