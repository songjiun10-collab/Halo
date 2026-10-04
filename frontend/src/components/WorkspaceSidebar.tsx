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

interface Shortcut { url: string; label: string }
const MAX_SHORTCUTS = 8

function toShortcut(raw: string): Shortcut | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    return { url: url.href, label: url.hostname.replace(/^www\./, '') }
  } catch { return null }
}

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
  const [pins, setPins] = useStored<Shortcut[]>('halo.shortcuts', [])
  const [adding, setAdding] = useState(false)
  const shown = pins.filter((pin) => pin && typeof pin === 'object')
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
        {shown.length < MAX_SHORTCUTS && (
          <button type="button" className="hx-sc hx-sc--empty" aria-label="Add shortcut" onClick={() => setAdding(true)}>+</button>
        )}
        {shown.map((pin, i) => (
          <button type="button" key={pin.url + i} className="hx-sc" title={`${pin.label} (right-click to remove)`} aria-label={pin.label}
            onClick={() => onOpenUrl(pin.url)} onContextMenu={(e) => { e.preventDefault(); setPins(shown.filter((_, j) => j !== i)) }}>{pin.label[0]?.toUpperCase()}</button>
        ))}
      </div>
      {adding && (
        <input className="hx-sc__input" autoFocus placeholder="Site address, then Enter" aria-label="Shortcut address"
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAdding(false)
            if (e.key !== 'Enter') return
            const next = toShortcut(e.currentTarget.value)
            if (next) setPins([...shown, next])
            setAdding(false)
          }} />
      )}
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
