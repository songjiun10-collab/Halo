import { useEffect, useRef, type KeyboardEvent } from 'react'
import { pageTitle } from '../session/pages'
import { AGENT, currentUrl, host } from '../session/session'
import type { Tab, TabActivity } from '../session/types'

const activityText: Record<TabActivity, string> = {
  working: `${AGENT} working`,
  waiting: `${AGENT} waiting for you`,
  paused: `${AGENT} paused`,
  done: `${AGENT} done`,
}

interface Props {
  tabs: Tab[]
  activeTabId: string
  onPick: (id: string) => void
  onClose: () => void
}

/** Every open tab as a card, like Safari's tab overview. Pick one to switch to it. */
export function TabOverview({ tabs, activeTabId, onPick, onClose }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { firstRef.current?.focus() }, [])
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
  return (
    <div className="hx-overview" role="dialog" aria-modal="true" aria-label="All tabs" onKeyDown={onKeyDown}>
      <div className="hx-overview__bar">
        <h2 className="hx-overview__title">{tabs.length} tabs</h2>
        <button className="hx-btn hx-btn--secondary hx-btn--compact" onClick={onClose}>Done</button>
      </div>
      <ul className="hx-overview__grid">
        {tabs.map((tab, i) => {
          const url = currentUrl(tab)
          return (
            <li key={tab.id}>
              <button
                ref={tab.id === activeTabId || (i === 0 && !tabs.some((t) => t.id === activeTabId)) ? firstRef : undefined}
                className="hx-card"
                title={pageTitle(url)}
                data-selected={tab.id === activeTabId || undefined}
                onClick={() => onPick(tab.id)}
              >
                <span className="hx-card__thumb" aria-hidden="true"><span>{pageTitle(url).split(' — ')[0]}</span></span>
                <span className="hx-card__title">{pageTitle(url)}</span>
                <span className="hx-card__meta">
                  <code>{url.startsWith('halo://') ? 'New tab' : host(url)}</code>
                  {tab.claude && <span className="hx-card__agent">{activityText[tab.claude]}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
