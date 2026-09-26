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
  return (
    <aside className="hx-side" aria-label="Agent">
      <div className="hx-side__head">
        <span>Agent</span>
        <span className="hx-demo">DEMO SESSION</span>
      </div>
      <p className="hx-side__task"><span className="hx-ai-label">Task · </span>{session.task}</p>
      <ol className="hx-log" aria-label="Agent steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {log.map((s) => (
          <li key={s.n} className="hx-log__item">
            <span>{s.n}</span>
            <span>
              {s.title}
              <small>{s.target}</small>
              {s.resolution && <small>{s.resolution === 'approved' ? 'Approved by you' : 'Denied by you'}</small>}
            </span>
            <VerdictBadge verdict={s.verdict} />
          </li>
        ))}
        {pending && (
          <li className="hx-log__item hx-log__item--current">
            <span>{pending.n}</span>
            <span>{pending.title}<small>{pending.target}</small></span>
            <VerdictBadge verdict="review" />
          </li>
        )}
      </ol>
      {agent === 'acting' && (
        <p className="hx-side__done" role="status">
          Working <span className="hx-typing" aria-hidden="true"><i /><i /><i /></span>
        </p>
      )}
      {agent === 'idle' && <p className="hx-side__done" role="status">Finished · {log.length} steps · at {clock(session.lastUpdate)}</p>}
      {pending && <ApprovalPrompt step={pending} disabled={agent === 'stopped'} onApprove={onApprove} onDeny={onDeny} />}
    </aside>
  )
}
