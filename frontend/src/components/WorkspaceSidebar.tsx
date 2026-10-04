import { useEffect, useState, type ReactNode } from 'react'
import { Plus } from './Icons'
import type { TaskSummary } from '../session/api'

interface Props {
  tasks: TaskSummary[]
  activeTaskId: string | null
  open: boolean
  inert?: boolean
  onNewTask: () => void
  onSelectTask: (taskId: string) => void
  /** Open browser tabs, listed under Tabs. */
  tabs: { id: string; title: string }[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  onOpenUrl: (url: string) => void
  /** Agents and Teams, listed after the tasks. */
  agents?: ReactNode
}

const stateLabel: Record<TaskSummary['state'], string> = {
  idle: 'Ready',
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  awaiting_verification: 'Review',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Complete',
}

const PINS = [
  { n: 'Instagram', g: 'i', c: '#e1306c', url: 'https://www.instagram.com' },
  { n: 'Google', g: 'G', c: '#4285f4', url: 'https://www.google.com' },
  { n: 'Slack', g: 'S', c: '#e01e5a', url: 'https://app.slack.com' },
  { n: 'Figma', g: 'F', c: '#a259ff', url: 'https://www.figma.com' },
  { n: 'Threads', g: '@', c: '#8a8d91', url: 'https://www.threads.net' },
  { n: 'Discord', g: 'D', c: '#5865f2', url: 'https://discord.com/app' },
]
interface Project { id: string; name: string; open: boolean; taskIds: string[] }

function useStored<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ } }, [key, value])
  return [value, setValue]
}

function TaskButton({ task, active, onClick, child }: { task: TaskSummary; active: boolean; onClick: () => void; child?: boolean }) {
  return (
    <button
      type="button"
      className={`hx-sidebar__item hx-sidebar__task${child ? ' hx-sidebar__item--child' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/halo-task', task.taskId)}
      data-selected={active || undefined}
      data-state={task.state}
      aria-current={active ? 'page' : undefined}
      title={task.originalRequest}
      onClick={onClick}
    >
      <span className="hx-sidebar__fav" aria-hidden="true">{task.originalRequest.trim().slice(0, 1) || '·'}</span>
      <span className="hx-sidebar__task-copy">
        <span className="hx-sidebar__task-title">{task.originalRequest}</span>
        <small className="hx-sidebar__task-state">{task.state === 'paused' && task.pauseReason === 'need_user' ? 'Needs your reply' : stateLabel[task.state]}</small>
      </span>
    </button>
  )
}

export function WorkspaceSidebar({ tasks, activeTaskId, open, inert, onNewTask, onSelectTask, tabs, activeTabId, onSelectTab, onOpenUrl, agents }: Props) {
  const [pins, setPins] = useStored<(string | null)[]>('halo.shortcuts', PINS.map((p) => p.n))
  const [projects, setProjects] = useStored<Project[]>('halo.projects', [])
  const [moreOpen, setMoreOpen] = useStored<boolean>('halo.sidebar.more', false)
  const [editing, setEditing] = useState<string | null>(null)
  const filed = new Set(projects.flatMap((project) => project.taskIds))
  const loose = tasks.filter((task) => !filed.has(task.taskId))
  const active = loose.filter((task) => task.active || ['queued', 'running', 'awaiting_approval', 'awaiting_verification', 'paused'].includes(task.state))
  const recent = loose.filter((task) => !active.includes(task))
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const patch = (id: string, change: Partial<Project>) => setProjects(projects.map((project) => (project.id === id ? { ...project, ...change } : project)))
  const drop = (projectId: string, taskId: string) => {
    if (!taskId) return
    setProjects(projects.map((project) => ({ ...project, taskIds: project.id === projectId ? [...project.taskIds.filter((id) => id !== taskId), taskId] : project.taskIds.filter((id) => id !== taskId) })))
  }
  const addProject = () => {
    const id = `p${Date.now()}`
    setProjects([...projects, { id, name: 'New project', open: true, taskIds: [] }])
    setEditing(id)
  }
  const list = (items: TaskSummary[], child?: boolean) => items.map((task) => (
    <TaskButton key={task.taskId} task={task} child={child} active={task.taskId === activeTaskId} onClick={() => onSelectTask(task.taskId)} />
  ))
  return (
    <aside className="hx-sidebar" data-open={open} aria-label="Workspace" inert={inert}>
      <div className="hx-scs" aria-label="Shortcuts">
        {pins.map((name, i) => {
          const pin = PINS.find((candidate) => candidate.n === name)
          return pin ? (
            <button type="button" key={i} className="hx-sc" style={{ color: pin.c }} title={`${pin.n} (right-click to remove)`} aria-label={pin.n}
              onClick={() => onOpenUrl(pin.url)} onContextMenu={(e) => { e.preventDefault(); setPins(pins.map((x, j) => (j === i ? null : x))) }}>{pin.g}</button>
          ) : (
            <button type="button" key={i} className="hx-sc hx-sc--empty" aria-label="Add shortcut"
              onClick={() => { const next = PINS.find((candidate) => !pins.includes(candidate.n)); if (next) setPins(pins.map((x, j) => (j === i ? next.n : x))) }}>+</button>
          )
        })}
      </div>
      <button type="button" className="hx-sidebar__item hx-sidebar__new" onClick={onNewTask}>
        <Plus />
        <span>New task</span>
        <kbd>⌘ K</kbd>
      </button>
      <p className="hx-sidebar__label">Tabs</p>
      {tabs.map((tab) => (
        <button type="button" key={tab.id} className="hx-sidebar__item" data-selected={(!activeTaskId && tab.id === activeTabId) || undefined} onClick={() => onSelectTab(tab.id)}>
          <span className="hx-sidebar__fav" aria-hidden="true">{tab.title.trim().slice(0, 1) || '?'}</span><span>{tab.title}</span>
        </button>
      ))}
      <p className="hx-sidebar__label hx-sidebar__label--row">Projects<button type="button" className="hx-sidebar__add" aria-label="New project folder" onClick={addProject}>+</button></p>
      {projects.map((project) => (
        <div key={project.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); drop(project.id, e.dataTransfer.getData('text/halo-task')) }}>
          <div className="hx-proj">
            <button type="button" className="hx-sidebar__item" onClick={() => patch(project.id, { open: !project.open })} onDoubleClick={() => setEditing(project.id)}
              onContextMenu={(e) => { e.preventDefault(); if (window.confirm(`Remove project "${project.name}"? Its tasks stay.`)) setProjects(projects.filter((x) => x.id !== project.id)) }}>
              <span className="hx-sidebar__fav" aria-hidden="true">{project.open ? '▾' : '▸'}</span>
              {editing === project.id
                ? <input autoFocus className="hx-sidebar__rename" defaultValue={project.name} onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { patch(project.id, { name: e.target.value.trim() || project.name }); setEditing(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }} />
                : <span>{project.name}</span>}
            </button>
          </div>
          {project.open ? list(project.taskIds.map((id) => byId.get(id)).filter((task): task is TaskSummary => !!task), true) : null}
        </div>
      ))}
      {active.length ? <><p className="hx-sidebar__label">In progress</p>{list(active)}</> : null}
      {recent.length ? <><p className="hx-sidebar__label">Recent tasks</p>{list(recent)}</> : null}
      <button type="button" className="hx-sidebar__item hx-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
        <span className="hx-sidebar__fav" style={{ transform: moreOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span><span>Agents &amp; routines</span>
      </button>
      {moreOpen ? agents : null}
      <div className="hx-sidebar__foot"><span>{tasks.length} saved {tasks.length === 1 ? 'task' : 'tasks'}</span></div>
    </aside>
  )
}
