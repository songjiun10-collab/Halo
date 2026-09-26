import type { ReactNode } from 'react'
import { currentUrl, splitUrl } from '../session/session'
import type { Tab } from '../session/types'
import { Back, Forward, Lock, NewWindow, Share, Tabs } from './Icons'

interface Props {
  tab: Tab
  /** Nothing needs a person: Halo's controls fold away until hover or keyboard focus. */
  folded: boolean
  locked: boolean
  onBack: () => void
  onForward: () => void
  onShare: () => void
  onOverview: () => void
  onNewWindow: () => void
  /** Sits inside the address field: who is driving this tab. */
  controller: ReactNode
  /** The Halo button, after the address field. */
  halo: ReactNode
}

export function Toolbar({ tab, folded, locked, onBack, onForward, onShare, onOverview, onNewWindow, controller, halo }: Props) {
  const url = currentUrl(tab)
  const parts = splitUrl(url)
  return (
    <div className="hx-toolbar" data-folded={folded || undefined}>
      <div className="hx-nav">
        <button className="hx-icbtn" aria-label="Back" disabled={locked || tab.index === 0} onClick={onBack}><Back /></button>
        <button className="hx-icbtn" aria-label="Forward" disabled={locked || tab.index === tab.history.length - 1} onClick={onForward}><Forward /></button>
      </div>
      <div className="hx-omni">
        {url.startsWith('https://') && <span className="hx-omni__lock" role="img" aria-label="Secure connection"><Lock /></span>}
        <span className="hx-omni__url" title={url}>
          <span className="hx-sr">Address </span>
          {parts.before}<b>{parts.domain}</b>{parts.after}
        </span>
        {controller}
      </div>
      <div className="hx-nav">
        <button className="hx-icbtn" aria-label="Share" title="Share" disabled={url.startsWith('halo://')} onClick={onShare}><Share /></button>
        <button className="hx-icbtn" aria-label="Show all tabs" title="Show all tabs" onClick={onOverview}><Tabs /></button>
        <button className="hx-icbtn" aria-label="New window" title="New window" onClick={onNewWindow}><NewWindow /></button>
      </div>
      {halo}
    </div>
  )
}
