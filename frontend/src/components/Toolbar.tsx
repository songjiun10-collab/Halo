import type { ReactNode } from 'react'
import { currentUrl, splitUrl } from '../session/session'
import type { Tab } from '../session/types'
import { Back, Forward, Lock } from './Icons'

interface Props {
  tab: Tab
  locked: boolean
  onBack: () => void
  onForward: () => void
  /** Sits inside the address field: who is driving this tab. */
  controller: ReactNode
  /** The Halo button, after the address field. */
  halo: ReactNode
}

export function Toolbar({ tab, locked, onBack, onForward, controller, halo }: Props) {
  const url = currentUrl(tab)
  const parts = splitUrl(url)
  return (
    <div className="hx-toolbar">
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
      {halo}
    </div>
  )
}
