import { useRef, type KeyboardEvent } from 'react'
import type { AgentState, Tab } from '../session/types'
import { AgentDot } from './AgentDot'
import { Close, Plus } from './Icons'

interface Props {
  tabs: Tab[]
  activeTabId: string
  agent: AgentState
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

function favicon(tab: Tab) {
  const host = /^https?:\/\/([^/]+)/.exec(tab.url)?.[1] ?? ''
  const label = host.split('.').slice(-2, -1)[0] ?? ''
  return (label[0] ?? '·').toUpperCase()
}

export function TabStrip({ tabs, activeTabId, agent, onSelect, onClose, onNew }: Props) {
  const refs = useRef<Record<string, HTMLDivElement | null>>({})

  // Roving tabindex: arrow keys move between tabs.
  function onKeyDown(e: KeyboardEvent, index: number) {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    onSelect(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div className="hx-strip" role="tablist" aria-label="Tabs">
      <div className="hx-lights" aria-hidden="true"><i /><i /><i /></div>
      {tabs.map((tab, i) => {
        const selected = tab.id === activeTabId
        const agentBusy = tab.agent && agent !== 'idle'
        return (
          <div
            key={tab.id}
            ref={(el) => { refs.current[tab.id] = el }}
            className={`hx-tab2${tab.agent ? ' hx-tab2--agent' : ''}`}
            role="tab"
            aria-selected={selected}
            aria-controls="hx-viewport"
            tabIndex={selected ? 0 : -1}
            title={tab.title}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {tab.agent ? <AgentDot state={agent} /> : <span className="hx-tab2__fav" aria-hidden="true">{favicon(tab)}</span>}
            <span className="hx-tab2__title">{tab.title}</span>
            <button
              className="hx-icbtn"
              aria-label={`Close ${tab.title}`}
              tabIndex={selected ? 0 : -1}
              disabled={agentBusy && agent !== 'stopped'}
              title={agentBusy && agent !== 'stopped' ? 'Stop the agent to close its tab' : undefined}
              onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
            >
              <Close />
            </button>
          </div>
        )
      })}
      <button className="hx-icbtn" aria-label="New tab" style={{ alignSelf: 'center' }} onClick={onNew}>
        <Plus />
      </button>
    </div>
  )
}
