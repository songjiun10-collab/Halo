import { Plus } from './Icons'
import type { TaskSummary } from '../session/api'

interface Props {
  tasks: TaskSummary[]
  activeTaskId: string | null
  open: boolean
  inert?: boolean
  onNewTask: () => void
  onSelectTask: (taskId: string) => void
}

const stateLabel: Record<TaskSummary['state'], string> = {
  idle: 'Ready',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  awaiting_verification: 'Review',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Complete',
}

function TaskButton({ task, active, onClick }: { task: TaskSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="hx-sidebar__item hx-sidebar__task"
      data-selected={active || undefined}
      data-state={task.state}
      aria-current={active ? 'page' : undefined}
      title={task.originalRequest}
      onClick={onClick}
    >
      <span className="hx-sidebar__fav" aria-hidden="true">{task.originalRequest.trim().slice(0, 1) || '·'}</span>
      <span className="hx-sidebar__task-copy">
        <span className="hx-sidebar__task-title">{task.originalRequest}</span>
        <small className="hx-sidebar__task-state">{stateLabel[task.state]}</small>
      </span>
    </button>
  )
}

export function WorkspaceSidebar({ tasks, activeTaskId, open, inert, onNewTask, onSelectTask }: Props) {
  const active = tasks.filter((task) => task.active || ['running', 'awaiting_approval', 'awaiting_verification', 'paused'].includes(task.state))
  const recent = tasks.filter((task) => !active.includes(task))
  return (
    <aside className="hx-sidebar" data-open={open} aria-label="Workspace" inert={inert}>
      <button type="button" className="hx-sidebar__item hx-sidebar__new" onClick={onNewTask}>
        <Plus />
        <span>New task</span>
        <kbd>⌘ K</kbd>
      </button>
      <p className="hx-sidebar__label">In progress</p>
      {active.length ? active.map((task) => (
        <TaskButton key={task.taskId} task={task} active={task.taskId === activeTaskId} onClick={() => onSelectTask(task.taskId)} />
      )) : <p className="hx-sidebar__empty">No active tasks</p>}
      <p className="hx-sidebar__label">Recent tasks</p>
      {recent.length ? recent.map((task) => (
        <TaskButton key={task.taskId} task={task} active={task.taskId === activeTaskId} onClick={() => onSelectTask(task.taskId)} />
      )) : <p className="hx-sidebar__empty">No recent tasks</p>}
      <div className="hx-sidebar__foot"><span>{tasks.length} saved {tasks.length === 1 ? 'task' : 'tasks'}</span></div>
    </aside>
  )
}
