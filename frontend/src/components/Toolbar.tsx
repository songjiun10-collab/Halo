import { currentUrl, splitUrl } from '../session/session'
import type { AgentState, Tab } from '../session/types'
import { AgentStatus } from './AgentStatus'
import { Back, Forward, Lock, PauseCircle, Play } from './Icons'

interface Props {
  tab: Tab
  locked: boolean
  agent: AgentState
  onBack: () => void
  onForward: () => void
  onPause: () => void
  onResume: () => void
}

export function Toolbar({ tab, locked, agent, onBack, onForward, onPause, onResume }: Props) {
  const url = currentUrl(tab)
  const parts = splitUrl(url)
  const running = agent === 'acting' || agent === 'waiting'
  return (
    <div className="hx-toolbar">
      <div className="hx-nav">
        <button className="hx-icbtn" aria-label="Back" disabled={locked || tab.index === 0} onClick={onBack}><Back /></button>
        <button className="hx-icbtn" aria-label="Forward" disabled={locked || tab.index === tab.history.length - 1} onClick={onForward}><Forward /></button>
      </div>
      <div className="hx-omni" title={url}>
        {url.startsWith('https://') && <span className="hx-omni__lock" role="img" aria-label="Secure connection"><Lock /></span>}
        <span className="hx-omni__url">
          <span className="hx-sr">Address </span>
          {parts.before}<b>{parts.domain}</b>{parts.after}
        </span>
      </div>
      <div className="hx-agentctl">
        <AgentStatus state={agent} />
        {running && <button className="hx-btn hx-btn--secondary hx-btn--compact" onClick={onPause}><PauseCircle />Pause agent</button>}
        {agent === 'stopped' && <button className="hx-btn hx-btn--secondary hx-btn--compact" onClick={onResume}><Play />Resume agent</button>}
      </div>
    </div>
  )
}
