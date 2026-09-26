import { useEffect, useRef } from 'react'
import type { SessionState } from '../session/types'
import { ApprovalPrompt } from './ApprovalPrompt'
import { VerdictBadge } from './VerdictBadge'

interface Props {
  session: SessionState
  onApprove: () => void
  onDeny: () => void
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function AgentPanel({ session, onApprove, onDeny }: Props) {
  const { log, pending, agent } = session
  const endRef = useRef<HTMLLIElement>(null)
  // Keep the newest step in view as the log grows.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [log.length, pending?.n])

  return (
    <aside className="hx-panel" aria-labelledby="hx-panel-title">
      <header className="hx-panel__head">
        <h2 id="hx-panel-title" className="hx-panel__title">Agent</h2>
        <span className="hx-demo">Demo session</span>
      </header>
      <p className="hx-panel__task"><span className="hx-meta">Task</span>{session.task}</p>
      <ol className="hx-log" aria-label="Agent steps">
        {log.map((s) => (
          <li key={s.n} className="hx-step" ref={s.n === log.length && !pending ? endRef : undefined}>
            <span className="hx-step__n num">{s.n}</span>
            <span className="hx-step__body">
              <span className="hx-step__title">{s.title}</span>
              <code className="hx-step__target">{s.target}</code>
              {s.resolution && <span className="hx-step__note">{s.resolution === 'approved' ? 'Approved by you' : 'Denied by you'}</span>}
            </span>
            <VerdictBadge verdict={s.verdict} />
          </li>
        ))}
        {pending && (
          <li className="hx-step" data-current ref={endRef}>
            <span className="hx-step__n num">{pending.n}</span>
            <span className="hx-step__body">
              <span className="hx-step__title">{pending.title}</span>
              <code className="hx-step__target">{pending.target}</code>
            </span>
            <VerdictBadge verdict="review" />
          </li>
        )}
      </ol>
      {agent === 'acting' && <p className="hx-panel__state">Working<span className="hx-typing" aria-hidden="true"><i /><i /><i /></span></p>}
      {agent === 'idle' && <p className="hx-panel__state">Finished at {clock(session.lastUpdate)} · {log.length} steps</p>}
      {pending && <ApprovalPrompt step={pending} paused={agent === 'stopped'} onApprove={onApprove} onDeny={onDeny} />}
    </aside>
  )
}
