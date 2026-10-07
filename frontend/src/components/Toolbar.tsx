import { useEffect, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { currentUrl } from '../session/session'
import { addressTarget } from '../session/navigation'
import type { Tab } from '../session/types'
import { ActivityLog, Back, Forward, Lock, Share, Sidebar, Tabs, Gear } from './Icons'

interface Props {
  tab: Tab
  /** Nothing needs a person: Halo's controls fold away until hover or keyboard focus. */
  folded: boolean
  locked: boolean
  omniRef: Ref<HTMLInputElement>
  onBack: () => void
  onForward: () => void
  onShare: () => void
  onOverview: () => void
  onActivity: () => void
  onNavigate: (url: string) => void
  /** Ask mode: the address field text becomes a task for the agent. */
  onAsk?: (text: string) => void
  onSettings: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  /** Sits inside the address field: who is driving this tab. */
  controller: ReactNode
  /** The Halo button, after the address field. */
  halo: ReactNode
}

export function Toolbar({ tab, folded, locked, omniRef, onBack, onForward, onShare, onOverview, onActivity, onNavigate, onAsk, onSettings, sidebarOpen, onToggleSidebar, controller, halo }: Props) {
  const url = currentUrl(tab)
  const addressUrl = url.startsWith('halo://') || url === 'about:blank' ? '' : url
  const [address, setAddress] = useState(addressUrl)
  useEffect(() => setAddress(addressUrl), [addressUrl])
  const [ask, setAsk] = useState(false)
  const submitAddress = (event: FormEvent) => {
    event.preventDefault()
    if (ask && onAsk) {
      const text = address.trim()
      if (text) { onAsk(text); setAddress(addressUrl); setAsk(false) }
      return
    }
    const target = addressTarget(address)
    if (target) onNavigate(target)
  }
  return (
    <div className="hx-toolbar" data-folded={folded || undefined}>
      <div className="hx-nav hx-nav--lead">
        <button className="hx-icbtn" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={sidebarOpen} title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={onToggleSidebar}><Sidebar /></button>
        <button className="hx-icbtn" aria-label="Back" aria-keyshortcuts="Alt+ArrowLeft" disabled={locked || !tab.canGoBack} onClick={onBack}><Back /></button>
        <button className="hx-icbtn" aria-label="Forward" aria-keyshortcuts="Alt+ArrowRight" disabled={locked || !tab.canGoForward} onClick={onForward}><Forward /></button>
      </div>
      <div className="hx-omni">
        {url.startsWith('https://') && <span className="hx-omni__lock" role="img" aria-label="Secure connection"><Lock /></span>}
        <form className="hx-omni__form" onSubmit={submitAddress}>
          <input ref={omniRef} className="hx-omni__input" aria-label="Address" placeholder={ask ? 'Ask Halo to do something' : 'Search or enter address'} value={address} onChange={(event) => setAddress(event.target.value)} disabled={locked} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          <button className="hx-sr" type="submit" tabIndex={-1}>Go</button>
        </form>
        {onAsk ? (
          <span className="hx-omni__mode" role="group" aria-label="Address mode">
            <button type="button" aria-pressed={!ask} onClick={() => setAsk(false)}>Tab</button>
            <button type="button" aria-pressed={ask} onClick={() => setAsk(true)}>Ask</button>
          </span>
        ) : null}
        {controller}
      </div>
      <div className="hx-nav">
        <button className="hx-icbtn" aria-label="Share" aria-keyshortcuts="Control+Shift+S Meta+Shift+S" title="Share" aria-disabled={url.startsWith('halo://') || undefined} onClick={onShare}><Share /></button>
        <button className="hx-icbtn" aria-label="Show all tabs" aria-keyshortcuts="Control+Shift+A Meta+Shift+A" title="Show all tabs" onClick={onOverview}><Tabs /></button>
        <button className="hx-icbtn" aria-label="View task activity" title="View task activity" onClick={onActivity}><ActivityLog /></button>
        <button className="hx-icbtn" aria-label="Settings" aria-keyshortcuts="Control+Comma Meta+Comma" title="Settings" onClick={onSettings}><Gear /></button>
      </div>
      {halo}
    </div>
  )
}
