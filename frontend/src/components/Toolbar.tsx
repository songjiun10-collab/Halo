import { agentLabel, splitUrl } from '../session/session'
import type { AgentState, Tab, Verdict } from '../session/types'
import { AgentDot } from './AgentDot'
import { Back, Forward, Lock, Play, Reload, Stop } from './Icons'
import { VerdictBadge } from './VerdictBadge'

interface Props {
  tab: Tab
  pageVerdict?: Verdict
  agent: AgentState
  onStop: () => void
  onResume: () => void
}

export function Toolbar({ tab, pageVerdict, agent, onStop, onResume }: Props) {
  const url = splitUrl(tab.url)
  const secure = tab.url.startsWith('https://')
  const running = agent === 'acting' || agent === 'waiting'
  return (
    <div className="hx-toolbar">
      <button className="hx-icbtn" aria-label="Back"><Back /></button>
      <button className="hx-icbtn" aria-label="Forward" disabled><Forward /></button>
      <button className="hx-icbtn" aria-label="Reload"><Reload /></button>
      <div className="hx-omni">
        {secure && <span role="img" aria-label="Secure connection"><Lock /></span>}
        <span className="hx-omni__url" title={tab.url}>
          <span className="hx-sr">Address: </span>
          {url.before}<b>{url.domain}</b>{url.after}
        </span>
        {pageVerdict && <VerdictBadge verdict={pageVerdict} />}
      </div>
      <span className="hx-pill" role="status">
        <AgentDot state={agent} />
        <span>{agentLabel[agent]}</span>
      </span>
      {running ? (
        <button className="hx-btn hx-btn--danger hx-stop" onClick={onStop}><Stop /> Stop agent</button>
      ) : agent === 'stopped' ? (
        <button className="hx-btn hx-btn--secondary hx-stop" onClick={onResume}><Play /> Resume</button>
      ) : null}
    </div>
  )
}
