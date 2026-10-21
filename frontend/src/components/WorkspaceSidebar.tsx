import { waitReasonLabel } from '../session/wait-reason'
import { BrandIcon } from './BrandIcon'
import { brandFor } from './brand-for'
import { useEffect, useState, type ReactNode } from 'react'
import { Close, Gear, Plus, Sidebar } from './Icons'
import type { TabActivity } from '../session/types'
import type { TabLayout } from '../session/tab-layout'
import { groupOf, type TabGroups } from '../session/tab-groups'
import type { TaskSummary } from '../session/api'

interface Props {
  tasks: TaskSummary[]
  activeTaskId: string | null
  open: boolean
  inert?: boolean
  onNewTask: () => void
  onSelectTask: (taskId: string) => void
  /** Open browser tabs, listed under Tabs. */
  tabs: { id: string; title: string; url?: string; activity?: TabActivity; closable?: boolean }[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  onOpenUrl: (url: string) => void
  onNewTab?: () => void
  onCloseTab?: (tabId: string) => void
  /** Where the tabs live; vertical puts them first in this sidebar and removes the strip above the page. */
  tabLayout?: TabLayout
  onToggleTabLayout?: () => void
  /** Tab groups; every group callback is optional so the sidebar still works without them. */
  groups?: TabGroups
  onCreateGroup?: (tabId: string) => void
  onAddToGroup?: (groupId: string, tabId: string) => void
  onRemoveFromGroup?: (tabId: string) => void
  onUngroup?: (groupId: string) => void
  onUngroupAll?: () => void
  onToggleGroup?: (groupId: string) => void
  onRenameGroup?: (groupId: string, name: string) => void
  /** Agents and Teams, listed first. */
  agents?: ReactNode
  onSettings?: () => void
  onToggleSidebar?: () => void
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
        <small className="hx-sidebar__task-state">{task.state === 'paused' && task.pauseReason === 'need_user' ? 'Needs your reply' : task.state === 'paused' && task.pauseReason === 'captcha' ? 'Needs you to pass a check' : task.state === 'paused' && task.pauseReason === 'login_required' ? 'Needs you to sign in' : task.state === 'queued' ? waitReasonLabel(task.waitReason) ?? stateLabel[task.state] : stateLabel[task.state]}</small>
      </span>
    </button>
  )
}

export function WorkspaceSidebar({ tasks, activeTaskId, open, inert, onNewTask, onSelectTask, tabs, activeTabId, onSelectTab, onOpenUrl, onNewTab, onCloseTab, tabLayout = 'horizontal', onToggleTabLayout, groups = [], onCreateGroup, onAddToGroup, onRemoveFromGroup, onUngroup, onUngroupAll, onToggleGroup, onRenameGroup, agents, onSettings, onToggleSidebar }: Props) {
  // One box filters tabs and chats by title, like the Halo for Chromium sidebar.
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const hit = (text: string | undefined) => !needle || (text ?? '').toLowerCase().includes(needle)
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
  const loose = tasks.filter((task) => !filed.has(task.taskId) && hit(task.originalRequest))
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
  const tabRow = (tab: Props['tabs'][number], inGroup?: boolean) => {
    const selected = (!activeTaskId && tab.id === activeTabId) || undefined
    const current = groupOf(groups, tab.id)
    return (
      <div key={tab.id} className={`hx-sidebar__tab${inGroup ? ' hx-sidebar__tab--grouped' : ''}`} data-selected={selected}>
        <button type="button" className="hx-sidebar__item hx-sidebar__tab-main" data-selected={selected} aria-current={selected ? 'page' : undefined} title={tab.title} onClick={() => onSelectTab(tab.id)}>
          <span className="hx-sidebar__fav" aria-hidden="true">{brandFor(hostOf(tab.url ?? "")) ? <BrandIcon host={hostOf(tab.url ?? "")} size={20} /> : tab.title.trim().slice(0, 1) || '?'}</span>
          <span className="hx-sidebar__tab-title">{tab.title}</span>
          {tab.activity ? <span className="hx-sidebar__tab-act" data-state={tab.activity} aria-hidden="true" /> : null}
          {tab.activity ? <span className="hx-sr">, agent {tab.activity}</span> : null}
        </button>
        {onCreateGroup && onAddToGroup && onRemoveFromGroup ? (
          <span className="hx-sidebar__tab-groupwrap" data-grouped={current ? true : undefined}>
            <span aria-hidden="true">▤</span>
            <select className="hx-sidebar__tab-group" aria-label={`Group for ${tab.title}`} title={current ? `Group: ${current.name}` : 'Add to group'} value={current?.id ?? ''}
              onChange={(e) => {
                const value = e.target.value
                if (value === '') onRemoveFromGroup(tab.id)
                else if (value === '__new') onCreateGroup(tab.id)
                else onAddToGroup(value, tab.id)
              }}>
              <option value="">No group</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              <option value="__new">New group…</option>
            </select>
          </span>
        ) : null}
        {tab.closable && onCloseTab ? (
          <button type="button" className="hx-icbtn hx-icbtn--sm hx-sidebar__tab-close" aria-label={`Close ${tab.title}`} onClick={() => onCloseTab(tab.id)}><Close /></button>
        ) : null}
      </div>
    )
  }
  const groupedIds = new Set(groups.flatMap((group) => group.tabIds))
  const byTabId = new Map(tabs.map((tab) => [tab.id, tab]))
  const tabsSection = section('tabs', 'Tabs', (
    <>
      {onNewTab ? (
        <button type="button" className="hx-sidebar__item hx-sidebar__new" onClick={onNewTab}><Plus /><span>New Tab</span></button>
      ) : null}
      {tabs.filter((tab) => !groupedIds.has(tab.id) && (hit(tab.title) || hit(tab.url))).map((tab) => tabRow(tab))}
      {groups.map((group) => (
        <div key={group.id} className="hx-sidebar__group" data-collapsed={group.collapsed || undefined}>
          <div className="hx-sidebar__group-head">
            <button type="button" className="hx-sidebar__item hx-sidebar__group-toggle" aria-expanded={!group.collapsed} onClick={() => onToggleGroup?.(group.id)} onDoubleClick={() => onRenameGroup && setEditing(group.id)}>
              <span className="hx-sidebar__fav" aria-hidden="true">{group.collapsed ? '▸' : '▾'}</span>
              {editing === group.id && onRenameGroup
                ? <input autoFocus className="hx-sidebar__rename" aria-label="Group name" defaultValue={group.name} onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { onRenameGroup(group.id, e.target.value); setEditing(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }} />
                : <span className="hx-sidebar__tab-title">{group.name}<small> · {group.tabIds.length}</small></span>}
            </button>
            {onUngroup ? <button type="button" className="hx-sidebar__add" aria-label={`Ungroup ${group.name}`} title="Ungroup (tabs stay open)" onClick={() => onUngroup(group.id)}>⤢</button> : null}
          </div>
          {group.collapsed ? null : group.tabIds.map((id) => byTabId.get(id)).filter((tab): tab is NonNullable<typeof tab> => !!tab).map((tab) => tabRow(tab, true))}
        </div>
      ))}
      {groups.length > 1 && onUngroupAll ? (
        <button type="button" className="hx-sidebar__item hx-sidebar__ungroup-all" onClick={onUngroupAll}><span>Ungroup all ({groups.length})</span></button>
      ) : null}
    </>
  ), onToggleTabLayout ? (
    <button type="button" className="hx-sidebar__add" aria-label={tabLayout === 'vertical' ? 'Show tabs in a strip above the page' : 'Show tabs in this sidebar instead of a strip'} aria-pressed={tabLayout === 'vertical'} title={tabLayout === 'vertical' ? 'Vertical tabs: on' : 'Vertical tabs: off'} onClick={onToggleTabLayout}>⇅</button>
  ) : undefined)
  return (
    <aside className="hx-sidebar" data-open={open} aria-label="Workspace" inert={inert}>
      <div className="hx-sidebar__top">
        {onNewTab ? <button type="button" className="hx-icbtn" aria-label="New tab" title="New tab" onClick={onNewTab}><Plus /></button> : null}
        {onToggleSidebar ? <button type="button" className="hx-icbtn" aria-label={open ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={open} title={open ? 'Hide sidebar' : 'Show sidebar'} onClick={onToggleSidebar}><Sidebar /></button> : null}
      </div>
      <label className="hx-sidebar__find">
        <span className="hx-sr">Search tabs and chats</span>
        <input type="search" placeholder="Search tabs & chats" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }} />
      </label>
      <div className="hx-sidebar__scroll">
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
      {tabsSection}
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
      </div>
      <div className="hx-sidebar__foot">
        <span>{tasks.length} saved {tasks.length === 1 ? 'task' : 'tasks'}</span>
        {onSettings ? <button type="button" className="hx-icbtn" aria-label="Settings" title="Settings" onClick={onSettings}><Gear /></button> : null}
      </div>
    </aside>
  )
}
