import type { ReactNode, Ref } from 'react'
import { currentUrl, splitUrl } from '../session/session'
import type { Tab } from '../session/types'
import { Back, Forward, Keyboard, Lock, NewWindow, Share, Tabs } from './Icons'

interface Props {
  tab: Tab
  /** Nothing needs a person: Halo's controls fold away until hover or keyboard focus. */
  folded: boolean
  locked: boolean
  omniRef: Ref<HTMLDivElement>
  onBack: () => void
  onForward: () => void
  onShare: () => void
  onOverview: () => void
  onNewWindow: () => void
  onHelp: () => void
  /** Sits inside the address field: who is driving this tab. */
  controller: ReactNode
  /** The Halo button, after the address field. */
  halo: ReactNode
}

export function Toolbar({ tab, folded, locked, omniRef, onBack, onForward, onShare, onOverview, onNewWindow, onHelp, controller, halo }: Props) {
  const url = currentUrl(tab)
  const parts = splitUrl(url)
  return (
    <div className="hx-toolbar" data-folded={folded || undefined}>
      <div className="hx-nav">
        <button className="hx-icbtn" aria-label="Back" aria-keyshortcuts="Alt+ArrowLeft" disabled={locked || tab.index === 0} onClick={onBack}><Back /></button>
        <button className="hx-icbtn" aria-label="Forward" aria-keyshortcuts="Alt+ArrowRight" disabled={locked || tab.index === tab.history.length - 1} onClick={onForward}><Forward /></button>
      </div>
      <div className="hx-omni" ref={omniRef} tabIndex={-1}>
        {url.startsWith('https://') && <span className="hx-omni__lock" role="img" aria-label="Secure connection"><Lock /></span>}
        <span className="hx-omni__url" title={url}>
          <span className="hx-sr">Address </span>
          {parts.before}<b>{parts.domain}</b>{parts.after}
        </span>
        {controller}
      </div>
      <div className="hx-nav">
        <button className="hx-icbtn" aria-label="Share" aria-keyshortcuts="Control+Shift+S Meta+Shift+S" title="Share" disabled={url.startsWith('halo://')} onClick={onShare}><Share /></button>
        <button className="hx-icbtn" aria-label="Show all tabs" aria-keyshortcuts="Control+Shift+A Meta+Shift+A" title="Show all tabs" onClick={onOverview}><Tabs /></button>
        <button className="hx-icbtn" aria-label="New window" aria-keyshortcuts="Control+N Meta+N" title="New window" onClick={onNewWindow}><NewWindow /></button>
        <button className="hx-icbtn" aria-label="Keyboard shortcuts" aria-keyshortcuts="Shift+?" title="Keyboard shortcuts" onClick={onHelp}><Keyboard /></button>
      </div>
      {halo}
    </div>
  )
}
