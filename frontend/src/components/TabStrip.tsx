import { useRef, type KeyboardEvent } from 'react'
import { pageTitle } from '../session/pages'
import { currentUrl } from '../session/session'
import type { AgentState, Tab } from '../session/types'
import { AgentDot } from './AgentStatus'
import { Close, Plus } from './Icons'
import { Logo } from './Logo'

interface Props {
  tabs: Tab[]
  activeTabId: string
  agent: AgentState
  canClose: (tab: Tab) => boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

function initial(url: string) {
  const host = /^https?:\/\/([^/]+)/.exec(url)?.[1]
  return host ? host.split('.').slice(-2, -1)[0][0].toUpperCase() : '·'
}

export function TabStrip({ tabs, activeTabId, agent, canClose, onSelect, onClose, onNew }: Props) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  // APG tabs: arrows move and select, Home/End jump, Delete closes.
  function onKeyDown(e: KeyboardEvent, i: number) {
    const last = tabs.length - 1
    const to = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key]
    if (to !== undefined) {
      e.preventDefault()
      onSelect(tabs[to].id)
      refs.current[tabs[to].id]?.focus()
    } else if (e.key === 'Delete' && canClose(tabs[i])) {
      e.preventDefault()
      onClose(tabs[i].id)
    }
  }

  return (
    <div className="hx-strip">
      <Logo />
      <div className="hx-tabs" role="tablist" aria-label="Tabs">
        {tabs.map((tab, i) => {
          const selected = tab.id === activeTabId
          const title = pageTitle(currentUrl(tab))
          return (
            <div key={tab.id} className="hx-tab" data-selected={selected} data-agent={tab.agent}>
              <button
                ref={(el) => { refs.current[tab.id] = el }}
                className="hx-tab__main"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                aria-controls="hx-page"
                tabIndex={selected ? 0 : -1}
                title={title}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
                aria-keyshortcuts={canClose(tab) ? "Delete" : undefined}
              >
                {tab.agent ? <AgentDot state={agent} /> : <span className="hx-tab__fav" aria-hidden="true">{initial(currentUrl(tab))}</span>}
                <span className="hx-tab__title">{title}</span>
                {tab.agent && <span className="hx-sr">, agent tab</span>}
              </button>
              {canClose(tab) && (
                <button className="hx-icbtn hx-icbtn--sm" aria-label={`Close ${title}`} tabIndex={-1} onClick={() => onClose(tab.id)}>
                  <Close />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button className="hx-icbtn" aria-label="New tab" onClick={onNew}>
        <Plus />
      </button>
    </div>
  )
}
