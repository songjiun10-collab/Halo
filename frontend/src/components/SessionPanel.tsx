import type { SessionState } from '../session/types'
import { Confirmation } from './Confirmation'
import { Timeline } from './Timeline'

interface Props {
  session: SessionState
  onApprove: () => void
  onDeny: () => void
}

export function SessionPanel({ session, onApprove, onDeny }: Props) {
  const approval = session.control === 'approval' ? session.pending?.approval : undefined
  return (
    <aside className="hx-panel" aria-label="Session activity">
      <p className="hx-panel__task">{session.task}<span className="hx-demo">Demo</span></p>
      <Timeline events={session.timeline} dim={!!approval} />
      {session.control === 'claude' && <p className="hx-panel__state">Working<span className="hx-typing" aria-hidden="true"><i /><i /><i /></span></p>}
      {approval && <Confirmation approval={approval} onApprove={onApprove} onDeny={onDeny} />}
    </aside>
  )
}
