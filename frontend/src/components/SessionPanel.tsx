import type { SessionState } from '../session/types'
import { ApprovalCard } from './ApprovalCard'
import { Timeline } from './Timeline'

interface Props {
  session: SessionState
  onApprove: () => void
  onDeny: () => void
}

export function SessionPanel({ session, onApprove, onDeny }: Props) {
  const approval = session.control === 'approval' ? session.pending?.approval : undefined
  return (
    <aside className="hx-panel" aria-labelledby="hx-panel-title">
      <header className="hx-panel__head">
        <h2 id="hx-panel-title" className="hx-panel__title">Session</h2>
        <span className="hx-demo">Demo</span>
      </header>
      <p className="hx-panel__task"><span className="hx-meta">Task</span>{session.task}</p>
      <Timeline events={session.timeline} dim={!!approval} />
      {session.control === 'claude' && <p className="hx-panel__state">Working<span className="hx-typing" aria-hidden="true"><i /><i /><i /></span></p>}
      {approval && <ApprovalCard approval={approval} onApprove={onApprove} onDeny={onDeny} />}
    </aside>
  )
}
