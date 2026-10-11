import { waitReasonLabel } from '../session/wait-reason'
import { BrandIcon, brandFor } from './BrandIcon'
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
  tabs: { id: string; title: string; url?: string }[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  /** Absent when tabs cannot be closed (a task is open, or only one tab is left). */
  onCloseTab?: (tabId: string) => void
  onOpenUrl: (url: string) => void
  onNewTab?: () => void
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

function hostOf(url: string) { try { return new URL(url).hostname } catch { return '' } }

interface Shortcut { url: string; label: string }
const MAX_SHORTCUTS = 8
const CHAT_LIMIT = 4

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
        <small className="hx-sidebar__task-state">{task.state === 'paused' && task.pauseReason === 'need_user' ? 'Needs your reply' : task.state === 'paused' && task.pauseReason === 'captcha' ? 'Needs you to pass a check' : task.state === 'queued' ? waitReasonLabel(task.waitReason) ?? stateLabel[task.state] : stateLabel[task.state]}</small>
      </span>
    </button>
  )
}

export function WorkspaceSidebar({ tasks, activeTaskId, open, inert, onNewTask, onSelectTask, tabs, activeTabId, onSelectTab, onCloseTab, onOpenUrl, onNewTab, agents }: Props) {
  const [pins, setPins] = useStored<Shortcut[]>('halo.shortcuts', [])
  const [adding, setAdding] = useState(false)
  const shown = pins.filter((pin) => pin && typeof pin === 'object')
  const [projects, setProjects] = useStored<Project[]>('halo.projects', [])
  const [folded, setFolded] = useStored<string[]>('halo.sidebar.folded', [])
  const toggleFold = (key: string) => setFolded(folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key])
  const section = (key: string, title: string, children: ReactNode, extra?: ReactNode) => (
    <section className="hx-sidebar__section" data-section={key}>
      <p className="hx-sidebar__label hx-sidebar__label--row">
        <button type="button" className="hx-sidebar__label--fold hx-sidebar__foldbtn" aria-expanded={!folded.includes(key)} onClick={() => toggleFold(key)}>
          <span className="hx-sidebar__chev" aria-hidden="true">›</span>{title}
        </button>
        {extra}
      </p>
      {folded.includes(key) ? null : children}
    </section>
  )
  const [showAll, setShowAll] = useState(false)
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
      {section('bookmarks', 'Bookmarks', (
        <>
          <div className="hx-scs" aria-label="Shortcuts">
            {shown.length < MAX_SHORTCUTS && (
              <button type="button" className="hx-sc hx-sc--empty" aria-label="Add shortcut" onClick={() => setAdding(true)}>+</button>
            )}
            {shown.map((pin, i) => (
              <button type="button" key={pin.url + i} className="hx-sc" title={`${pin.label} (right-click to remove)`} aria-label={pin.label}
                onClick={() => onOpenUrl(pin.url)} onContextMenu={(e) => { e.preventDefault(); setPins(shown.filter((_, j) => j !== i)) }}>{brandFor(pin.label) ? <BrandIcon host={pin.label} size={28} /> : pin.label[0]?.toUpperCase()}</button>
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
        </>
      ))}
      {agents ? <div className="hx-sidebar__agents">{agents}</div> : null}
      {section('chats', 'Chats', (
        <>
          <button type="button" className="hx-sidebar__item hx-sidebar__new" onClick={onNewTask}>
            <Plus />
            <span>New Chat</span>
            <kbd>⌘ K</kbd>
          </button>
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
          {list(active)}
          {list(showAll ? recent : recent.slice(0, Math.max(0, CHAT_LIMIT - active.length)))}
          {active.length + recent.length > CHAT_LIMIT ? (
            <button type="button" className="hx-sidebar__item hx-sidebar__showall" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : 'Show all'}</button>
          ) : null}
        </>
      ), <button type="button" className="hx-sidebar__add" aria-label="New project folder" onClick={addProject}>+</button>)}
      {section('tabs', 'Tabs', (
        <>
          {onNewTab ? (
            <button type="button" className="hx-sidebar__item hx-sidebar__new" onClick={onNewTab}><Plus /><span>New Tab</span></button>
          ) : null}
          {tabs.map((tab) => (
            <div key={tab.id} className="hx-sidebar__tabrow">
              <button type="button" className="hx-sidebar__item" data-selected={(!activeTaskId && tab.id === activeTabId) || undefined} onClick={() => onSelectTab(tab.id)}>
                <span className="hx-sidebar__fav" aria-hidden="true">{brandFor(hostOf(tab.url ?? "")) ? <BrandIcon host={hostOf(tab.url ?? "")} size={20} /> : tab.title.trim().slice(0, 1) || '?'}</span><span>{tab.title}</span>
              </button>
              {onCloseTab ? <button type="button" className="hx-sidebar__tabclose" aria-label={`Close ${tab.title}`} onClick={() => onCloseTab(tab.id)}>×</button> : null}
            </div>
          ))}
        </>
      ))}
      <div className="hx-sidebar__foot"><span>{tasks.length} saved {tasks.length === 1 ? 'task' : 'tasks'}</span></div>
    </aside>
  )
}
