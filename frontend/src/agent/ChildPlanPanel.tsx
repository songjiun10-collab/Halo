import type { ChildAgentStatus, ChildBoardKind, ChildPlanSummary } from '../session/child-agents'
import type { AgentRecord, Avatar as AvatarT } from './agent-api'
import { Avatar, OrchestratorMark } from './AgentUi'

const LBL: Record<ChildAgentStatus, string> = { queued: 'Queued', running: 'Running', waiting_for_review: 'Needs review', paused: 'Paused', completed: 'Done', failed: 'Failed', uncertain: 'Uncertain', stopped: 'Stopped' }
/** Children missing from the agent roster render as a neutral gray character. */
const FALLBACK: AvatarT = { shape: 'circle', color: 'gray' }

const KIND: Record<ChildBoardKind, string> = { progress: 'Progress', evidence: 'Evidence', handoff: 'Handoff' }

/** Renders the host-owned ChildPlanSummary (from getChildPlan / TaskEvent.childPlan). Read-only: the renderer never edits the count. */
export function ChildPlanPanel({ plan, agents: roster = [] }: { plan: ChildPlanSummary | null | undefined; agents?: AgentRecord[] }) {
  if (!plan) return null
  const { agents, requestedAgentCount: n, activeAgentCount: act, queuedAgentCount: q, memoryPolicy } = plan
  // The parent-authored job names a child first; then a matching agent's name; else the id prefix.
  const who = (c: { agentId: string; subgoal?: string }) => { const a = roster.find((r) => r.id === c.agentId); return { avatar: a?.avatar ?? FALLBACK, label: c.subgoal || a?.name || c.agentId.slice(0, 6) } }
  const label = (id: string) => { const i = agents.findIndex((c) => c.agentId === id); return agents[i]?.subgoal || `Agent ${i + 1}` }
  const done = agents.filter((c) => c.status === 'completed').length
  return <section className="hx-xplan hx-gl" aria-label="Sub-task plan">
    <header><OrchestratorMark size={34} /><b>Sub-tasks</b><small>{`${done} of ${n} done · ${act} active${q ? ` · ${q} queued` : ''}`}</small></header>
    <div className="hx-xbar"><i style={{ width: `${(done / n) * 100}%` }} /></div>
    <ol>{agents.map((c) => <li key={c.agentId} data-s={c.status}><i className="hx-xdot" /><Avatar avatar={who(c).avatar} size={26} /><span><b>{who(c).label}</b><small>{`${c.assignedOrigin} · ${c.evidenceCount} evidence${c.reason ? ` · ${c.reason}` : ''}`}</small></span><em>{LBL[c.status]}</em></li>)}</ol>
    {plan.board?.length ? <section className="hx-xboard" aria-label="Team board">
      <header><b>Team board</b><small>Notes sub-tasks share with each other</small></header>
      <ol>{plan.board.map((e) => <li key={e.entryId} data-k={e.kind}><span><b>{label(e.agentId)}</b><small>{KIND[e.kind]}</small></span><p>{e.text}</p></li>)}</ol>
    </section> : null}
    <p className="hx-ag__note hx-ag__note--eye"><span>{`Watch only. Agent count is set by the host ${memoryPolicy === 'user_override' ? '(memory limit overridden)' : 'within the memory budget'}. You can view and scroll sub-tasks, but not click or type in them.`}</span></p>
  </section>
}
