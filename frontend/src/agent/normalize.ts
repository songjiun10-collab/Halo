/** Host rows carry { originalRequest, state }; the Agent view reads { title, status }. Convert once, here. */
import type { ConversationLink, OwnerKind, RosterStatus } from './agent-api'

export type UiStatus = 'running' | 'done' | 'waiting'
export interface UiConversation { taskId: string; createdAt: string; unread: boolean; ownerId: string; kind: OwnerKind; task: null | { title: string; status: UiStatus } }
export type RosterDot = 'idle' | 'working' | 'unread'

const STATE: Record<string, UiStatus> = { running: 'running', idle: 'running', awaiting_approval: 'waiting', awaiting_verification: 'waiting', paused: 'waiting', completed: 'done', stopped: 'done' }
const IN_PROGRESS = new Set(['running', 'idle'])
export const statusLabel: Record<UiStatus, string> = { running: 'Running', waiting: 'Waiting', done: 'Done' }

/** Unread follows the host's roster rule: a settled state the user has not seen yet. */
export function toUi(row: ConversationLink): UiConversation {
  const task = row.task
  return {
    taskId: row.taskId, createdAt: row.createdAt, ownerId: row.ownerId, kind: row.kind,
    unread: !!task && !IN_PROGRESS.has(task.state) && task.state !== row.seenState,
    task: task ? { title: task.originalRequest, status: STATE[task.state] ?? 'waiting' } : null,
  }
}

export function rosterDot(status: RosterStatus | undefined): RosterDot {
  if (!status) return 'idle'
  if (status.running > 0) return 'working'
  return status.awaitingUser > 0 || status.hasUnread ? 'unread' : 'idle'
}

export const ago = (iso: string) => {
  const m = Math.max(1, Math.round((Date.now() - +new Date(iso)) / 6e4))
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}
