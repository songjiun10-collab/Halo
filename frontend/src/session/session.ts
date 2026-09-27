import { getDomain } from 'tldts'
import type { BrowserAction, HaloBrowserApi, JournalEvent, TaskEvent, TaskSnapshot } from './api'
import type { Approval, Control, PendingCriterion, SessionState, Tab, TabActivity, TimelineEvent } from './types'

export const AGENT = 'Agent'
export const AGENT_ROLE = 'Agent'
export const NEW_TAB_URL = 'halo://newtask'
export const controlLabel: Record<Control, string> = { claude: 'Agent is browsing', approval: 'Agent is waiting for you', you: 'You are browsing' }
export const currentUrl = (tab?: Tab) => tab?.history[tab.index] ?? ''
export const canNavigate = (s: SessionState) => !!s.activeTaskId && !!s.snapshot && ['paused', 'completed', 'stopped'].includes(s.snapshot.state)
export const host = (url: string) => { try { return new URL(url).hostname || url } catch { return url } }

export function splitUrl(url: string): { before: string; domain: string; after: string } {
  let u: URL
  try { u = new URL(url) } catch { return { before: '', domain: url, after: '' } }
  if (!/^https?:$/.test(u.protocol)) return { before: '', domain: url, after: '' }
  const domain = getDomain(u.hostname, { allowPrivateDomains: true }) ?? u.host
  const at = u.host.lastIndexOf(domain)
  return { before: u.protocol + '//' + (at > 0 ? u.host.slice(0, at) : ''), domain: at >= 0 ? u.host.slice(at) : u.host, after: u.pathname + u.search + u.hash }
}

export function initialSession(connected = false): SessionState {
  return { connected, activeTaskId: null, tasks: [], goal: null, snapshot: null, browser: null, recoveryReason: null, task: '', control: 'you', finished: true, tabs: [], activeTabId: '', timeline: [], journal: [], messages: [], loading: false, busy: null, error: null }
}

function describeEvent(e: JournalEvent): TimelineEvent {
  const p = e.payload
  const labels: Record<JournalEvent['type'], string> = {
    goal_created: 'Created the task', goal_amended: 'Amended the goal', action_started: 'Started an action', action_outcome: `Action ${String(p.status ?? 'finished')}`, evidence_recorded: 'Recorded criterion evidence', approval_cancelled: 'Cancelled an approval', note: String(p.msg ?? p.text ?? 'Recorded a note'),
  }
  const evidence = p.evidence as { criterionId?: string; verification?: string } | undefined
  const detail = evidence ? `${evidence.criterionId ?? ''} · ${evidence.verification ?? 'pending'}` : p.reason ?? p.actionId
  return { id: e.seq, actor: e.type.startsWith('goal_') ? 'you' : e.type === 'approval_cancelled' ? 'halo' : 'claude', text: labels[e.type], detail: detail === undefined ? undefined : String(detail), notable: !['action_started', 'action_outcome'].includes(e.type), at: e.at }
}

function derive(s: SessionState): SessionState {
  const snapshot = s.snapshot
  const head = snapshot?.approvalQueue[0]
  const state = snapshot?.state
  const activity: TabActivity | undefined = state === 'running' ? 'working' : state === 'awaiting_approval' || state === 'awaiting_verification' ? 'waiting' : state === 'paused' ? 'paused' : state === 'completed' || state === 'stopped' ? 'done' : undefined
  return {
    ...s,
    task: s.goal?.originalRequest ?? s.tasks.find((t) => t.taskId === s.activeTaskId)?.originalRequest ?? '',
    control: head ? 'approval' : state === 'running' ? 'claude' : 'you',
    finished: !state || state === 'completed' || state === 'stopped',
    tabs: s.browser?.tabs.map((t) => ({ id: t.id, history: [t.url], index: 0, titles: { [t.url]: t.title || t.url }, claude: activity, canGoBack: t.canGoBack, canGoForward: t.canGoForward })) ?? [],
    activeTabId: s.browser?.activeTabId ?? '',
    approval: head && s.activeTaskId ? { taskId: s.activeTaskId, id: head.id, action: head.summary || head.action, request: head.action, createdAt: head.createdAt } : undefined,
    messages: s.goal ? [{ from: 'you', text: s.goal.originalRequest }, ...s.goal.amendments.map((m) => ({ from: 'you' as const, text: m.text }))] : [],
    timeline: s.journal.map(describeEvent),
  }
}

export function pendingCriteria(s: SessionState): PendingCriterion[] {
  if (!s.goal || !s.snapshot || !s.activeTaskId || s.snapshot.state === 'stopped') return []
  return s.goal.criteria.flatMap((criterion) => {
    const status = s.snapshot?.criteriaStatus.find((item) => item.criterionId === criterion.id)
    return criterion.verification === 'user' && status?.status === 'pending' && status.goalVersion === s.goal?.goalVersion && status.goalVersion === s.snapshot?.goalVersion && status.evidenceId
      ? [{ taskId: s.activeTaskId!, criterionId: criterion.id, text: criterion.text, goalVersion: status.goalVersion, evidenceId: status.evidenceId }]
      : []
  })
}

/** IPC lives outside rendering. Each selection and push invalidates older reads. */
export class SessionStore {
  private api?: HaloBrowserApi
  private state: SessionState
  private listeners = new Set<() => void>()
  private selection = 0
  private listRevision = 0
  private revisions = new Map<string, number>()
  private details = new Map<string, number>()
  private eventFlights = new Map<string, Promise<void>>()
  private eventDirty = new Set<string>()
  private pendingCreate: { text: string; selection: number; known: Set<string> } | null = null
  private commandToken = 0
  constructor(api?: HaloBrowserApi) { this.api = api; this.state = initialSession(!!api) }
  getState = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<SessionState>) { this.state = derive({ ...this.state, ...patch }); this.listeners.forEach((listener) => listener()) }
  private current(taskId: string, selection: number) { return this.state.activeTaskId === taskId && this.selection === selection }
  private revision(taskId: string) { return this.revisions.get(taskId) ?? 0 }
  private failure(error: unknown, taskId?: string, selection = this.selection) {
    if (selection !== this.selection || (taskId && taskId !== this.state.activeTaskId)) return
    this.update({ error: error instanceof Error ? error.message : String(error) })
  }
  clearError = () => this.update({ error: null })
  connect() {
    if (!this.api) return () => {}
    const unsubscribe = this.api.onTaskEvent((event) => this.receive(event))
    void this.refreshTasks()
    return unsubscribe
  }
  async refreshTasks() {
    if (!this.api) return
    const revision = ++this.listRevision
    try { const tasks = await this.api.listTasks(); if (revision === this.listRevision) this.update({ tasks }) }
    catch (error) { if (revision === this.listRevision) this.failure(error) }
  }
  newTask = () => {
    this.selection++
    this.pendingCreate = null
    this.commandToken++
    this.update({ ...initialSession(!!this.api), tasks: this.state.tasks })
  }
  async selectTask(taskId: string) {
    if (!this.api) return false
    const selection = ++this.selection
    this.pendingCreate = null
    this.commandToken++
    this.update({ ...initialSession(true), tasks: this.state.tasks, activeTaskId: taskId, loading: true })
    try {
      const revision = this.revision(taskId)
      const detail = await this.api.getTaskDetail(taskId)
      if (!this.current(taskId, selection)) return false
      this.update({ goal: detail.goal, ...(revision === this.revision(taskId) ? { snapshot: detail.snapshot ?? null } : {}), recoveryReason: detail.recoveryReason ?? null })
      if (!detail.active && detail.recoveryReason !== 'execution_uncertain') {
        // Attaching may start a long run; pushed state unlocks the UI immediately.
        void this.runCommand('resume', () => this.api!.resumeSavedTask(taskId), taskId)
      }
      await this.refresh(taskId, selection, false)
      return true
    } catch (error) { this.failure(error, taskId, selection); return false }
    finally { if (this.current(taskId, selection)) this.update({ loading: false }) }
  }
  private receive(event: TaskEvent) {
    this.revisions.set(event.taskId, this.revision(event.taskId) + 1)
    this.listRevision++
    const summary = this.state.tasks.find((task) => task.taskId === event.taskId)
    const request = event.goal?.originalRequest ?? summary?.originalRequest
    if (request !== undefined) {
      const next = { taskId: event.taskId, originalRequest: request, state: event.snapshot.state, pauseReason: event.snapshot.pauseReason, active: true }
      this.update({ tasks: [next, ...this.state.tasks.filter((task) => task.taskId !== event.taskId)] })
    }
    const pending = this.pendingCreate
    if (pending && pending.selection === this.selection && !pending.known.has(event.taskId) && event.goal?.originalRequest === pending.text) {
      this.pendingCreate = null
      this.update({ activeTaskId: event.taskId, goal: event.goal, busy: null, loading: false })
    }
    if (event.taskId !== this.state.activeTaskId) return
    const patch: Partial<SessionState> = { snapshot: event.snapshot, recoveryReason: null, loading: false }
    if (event.goal) patch.goal = event.goal
    if (event.browser) patch.browser = event.browser
    if (this.state.busy === 'resume' && event.snapshot.state !== 'paused') patch.busy = null
    this.update(patch)
    void this.refresh(event.taskId, this.selection, !event.goal, !event.browser, false)
  }
  // trustDetailSnapshot: a push (receive()) already applied its own event.snapshot
  // directly and just wants getTaskDetail for a `goal` it didn't carry -- that
  // detail response's own snapshot has no revision of its own and must never be
  // allowed to replay over the fresher one the push already delivered.
  private async refresh(taskId: string, selection: number, withDetail = true, withBrowser = true, trustDetailSnapshot = true) {
    if (!this.api || !this.current(taskId, selection)) return
    const detailNumber = (this.details.get(taskId) ?? 0) + 1
    this.details.set(taskId, detailNumber)
    const revision = this.revision(taskId)
    const reads: Promise<void>[] = [this.refreshEvents(taskId, selection)]
    if (withDetail) reads.push(this.api.getTaskDetail(taskId).then((detail) => {
      if (!this.current(taskId, selection) || this.details.get(taskId) !== detailNumber) return
      const patch: Partial<SessionState> = {}
      if (!this.state.goal || detail.goal.goalVersion >= this.state.goal.goalVersion) patch.goal = detail.goal
      if (trustDetailSnapshot && revision === this.revision(taskId)) { patch.snapshot = detail.snapshot ?? null; patch.recoveryReason = detail.recoveryReason ?? null }
      this.update(patch)
    }))
    if (withBrowser) reads.push(this.api.getTaskBrowser(taskId).then((browser) => {
      if (this.current(taskId, selection) && revision === this.revision(taskId) && this.details.get(taskId) === detailNumber) this.update({ browser })
    }))
    const results = await Promise.allSettled(reads)
    for (const result of results) if (result.status === 'rejected') this.failure(result.reason, taskId, selection)
  }
  private refreshEvents(taskId: string, selection: number): Promise<void> {
    const key = `${selection}:${taskId}`
    const running = this.eventFlights.get(key)
    if (running) { this.eventDirty.add(key); return running }
    const promise = (async () => {
      do {
        this.eventDirty.delete(key)
        let more = true
        while (more && this.current(taskId, selection)) {
          const since = this.state.journal.at(-1)?.seq ?? 0
          const events = await this.api!.getTaskEvents(taskId, { since })
          if (!this.current(taskId, selection)) return
          const valid = events.filter((e) => e.taskId === taskId && e.seq > since)
          if (valid.length) this.update({ journal: [...this.state.journal, ...valid].sort((a, b) => a.seq - b.seq).filter((e, i, all) => i === 0 || e.seq !== all[i - 1].seq) })
          more = events.length === 200 && valid.length > 0
        }
      } while (this.eventDirty.has(key) && this.current(taskId, selection))
    })().finally(() => { this.eventFlights.delete(key); this.eventDirty.delete(key) })
    this.eventFlights.set(key, promise)
    return promise
  }
  private async runCommand(label: string, operation: () => Promise<TaskSnapshot>, taskId = this.state.activeTaskId) {
    if (!taskId || !this.api || this.state.busy) return false
    const selection = this.selection
    const revision = this.revision(taskId)
    const token = ++this.commandToken
    this.update({ busy: label, error: null })
    try {
      const snapshot = await operation()
      if (!this.current(taskId, selection)) return true
      // A push that landed while `operation` was in flight already carries a
      // newer snapshot than this response -- besides skipping the direct
      // assignment, the follow-up refresh must also stay out of the way,
      // since getTaskDetail/getTaskBrowser have no revision of their own and
      // could otherwise reintroduce exactly the stale state the push moved
      // past (e.g. an approval queue head the push already advanced).
      const fresh = revision === this.revision(taskId)
      if (fresh) this.update({ snapshot })
      await this.refresh(taskId, selection, fresh, fresh)
      return true
    } catch (error) { this.failure(error, taskId, selection); return false }
    finally { if (this.current(taskId, selection) && token === this.commandToken) this.update({ busy: null }) }
  }
  async sendMessage(text: string) {
    if (!this.api || this.state.busy || !text.trim()) return false
    if (new TextEncoder().encode(text).length > 16384) { this.update({ error: 'The request must be 16 KB or less.' }); return false }
    const taskId = this.state.activeTaskId
    if (taskId) return this.runCommand('amend', () => this.api!.amendTask(taskId, { text, supersedesConstraintIds: [], newConstraints: [], newCriteria: [] }))
    const selection = this.selection
    const token = ++this.commandToken
    this.pendingCreate = { text, selection, known: new Set(this.state.tasks.map((task) => task.taskId)) }
    this.update({ busy: 'create', error: null })
    try {
      const result = await this.api.createTask({ originalRequest: text })
      if (selection !== this.selection) return true
      if (!this.state.activeTaskId) this.update({ activeTaskId: result.taskId, goal: result.goal, snapshot: result.snapshot })
      if (this.state.activeTaskId === result.taskId) await this.refresh(result.taskId, selection)
      await this.refreshTasks()
      return true
    } catch (error) { this.failure(error, undefined, selection); return false }
    finally { if (selection === this.selection && token === this.commandToken) { this.pendingCreate = null; this.update({ busy: null }) } }
  }
  decideApproval(kind: 'approve' | 'deny', approval: Approval) {
    if (approval.taskId !== this.state.activeTaskId || approval.id !== this.state.approval?.id) return Promise.resolve(false)
    return this.runCommand(kind, () => kind === 'approve' ? this.api!.taskApprove(approval.taskId, approval.id) : this.api!.taskDeny(approval.taskId, approval.id))
  }
  confirmCriterion(criterion: PendingCriterion, outcome: 'verified' | 'rejected') {
    if (!pendingCriteria(this.state).some((c) => c.taskId === criterion.taskId && c.criterionId === criterion.criterionId && c.goalVersion === criterion.goalVersion && c.evidenceId === criterion.evidenceId)) return Promise.resolve(false)
    const { criterionId, goalVersion, evidenceId } = criterion
    return this.runCommand('confirm', () => this.api!.confirmCriterion(criterion.taskId, { criterionId, goalVersion, evidenceId, outcome }))
  }
  control(action: 'pause' | 'stop' | 'takeOver' | 'resume', confirmed = false) {
    const taskId = this.state.activeTaskId
    if (!taskId) return Promise.resolve(false)
    return this.runCommand(action, () => {
      if (action === 'pause') return this.api!.taskPause(taskId)
      if (action === 'stop') return this.api!.taskStop(taskId)
      if (action === 'takeOver') return this.api!.taskTakeOver(taskId)
      return this.api!.resumeSavedTask(taskId, confirmed ? { confirmed: true } : {})
    })
  }
  async navigate(action: BrowserAction) {
    if (!this.api || !canNavigate(this.state) || this.state.busy) return false
    const taskId = this.state.activeTaskId!
    const selection = this.selection
    const token = ++this.commandToken
    this.update({ busy: 'navigate', error: null })
    try { const browser = await this.api.taskBrowserAction(taskId, action); if (this.current(taskId, selection)) this.update({ browser }); return true }
    catch (error) { this.failure(error, taskId, selection); return false }
    finally { if (this.current(taskId, selection) && token === this.commandToken) this.update({ busy: null }) }
  }
}
