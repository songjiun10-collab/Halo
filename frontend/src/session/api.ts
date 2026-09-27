/** Renderer view of the existing harness contracts and trusted preload methods. */
export type TaskState = 'idle' | 'running' | 'awaiting_approval' | 'awaiting_verification' | 'paused' | 'stopped' | 'completed'
export interface GoalCriterion { id: string; text: string; required: boolean; verification: 'host' | 'user'; sourceMessageId?: string }
export interface GoalConstraint { id: string; text: string; sourceMessageId?: string }
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
}
export interface GoalInput { originalRequest: string; constraints?: GoalConstraint[]; criteria?: GoalCriterion[]; limits?: Partial<GoalSpec['limits']> }
export interface AmendmentInput { text: string; supersedesConstraintIds: string[]; newConstraints: GoalConstraint[]; newCriteria: GoalCriterion[] }
export interface CriterionStatus { criterionId: string; status: 'pending' | 'verified' | 'rejected'; evidenceId: string; goalVersion: number }
export interface CriterionConfirmation { criterionId: string; goalVersion: number; evidenceId: string; outcome: 'verified' | 'rejected' }
export interface ApprovalRequest { id: string; summary: string; action: string; createdAt: string }
export interface TaskSnapshot {
  state: TaskState
  pauseReason: string | null
  goalVersion: number
  budgets: Record<string, number>
  segment: Record<string, unknown>
  criteriaStatus: CriterionStatus[]
  approvalQueue: ApprovalRequest[]
}
export interface TaskSummary { taskId: string; originalRequest: string; state: TaskState; pauseReason: string | null; active: boolean }
export interface TaskDetail { taskId: string; goal: GoalSpec; snapshot?: TaskSnapshot; active: boolean; recoveryReason?: string }
export interface BrowserSnapshot {
  tabs: { id: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean }[]
  activeTabId: string
  documentEpoch: number
}
export interface TaskEvent { taskId: string; snapshot: TaskSnapshot; goal?: GoalSpec; browser?: BrowserSnapshot }
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
export interface HaloBrowserApi {
  createTask(input: GoalInput): Promise<{ taskId: string; snapshot: TaskSnapshot; goal: GoalSpec }>
  listTasks(): Promise<TaskSummary[]>
  getTaskDetail(taskId: string): Promise<TaskDetail>
  resumeSavedTask(taskId: string, opts?: { confirmed?: boolean }): Promise<TaskSnapshot>
  amendTask(taskId: string, input: AmendmentInput): Promise<TaskSnapshot>
  confirmCriterion(taskId: string, input: CriterionConfirmation): Promise<TaskSnapshot>
  taskApprove(taskId: string, approvalId: string): Promise<TaskSnapshot>
  taskDeny(taskId: string, approvalId: string): Promise<TaskSnapshot>
  taskPause(taskId: string): Promise<TaskSnapshot>
  taskStop(taskId: string): Promise<TaskSnapshot>
  taskTakeOver(taskId: string): Promise<TaskSnapshot>
  getTaskEvents(taskId: string, options?: { since?: number }): Promise<JournalEvent[]>
  getTaskBrowser(taskId: string): Promise<BrowserSnapshot>
  taskBrowserAction(taskId: string, action: BrowserAction): Promise<BrowserSnapshot>
  setTaskViewport(taskId: string | null, viewport: BrowserViewport): Promise<unknown>
  onTaskEvent(callback: (event: TaskEvent) => void): () => void
}
declare global { interface Window { haloBrowser?: HaloBrowserApi } }
