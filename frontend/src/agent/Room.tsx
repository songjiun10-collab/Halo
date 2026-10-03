import { useEffect, useRef, useState } from 'react'
import { LIM, applyRoomEvent, errText, type AgentRecord, type RoomApi, type RoomMessage, type RoomRound } from './agent-api'
import { Avatar } from './AgentUi'

type Named = Pick<AgentRecord, 'id' | 'name' | 'avatar'>
const IDLE: RoomRound = { active: false, turn: 0, speakerId: null }

/** Pure view of a room log: passes are skipped, a started task links to the task UI. */
export function RoomTranscript({ messages, agents, round, onOpenTask }: { messages: RoomMessage[]; agents: Named[]; round: RoomRound; onOpenTask: (taskId: string) => void }) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const speaker = round.active && round.speakerId ? byId.get(round.speakerId) : undefined
  return <ol className="hx-room__log" aria-live="polite">
    {messages.map((m) => {
      if (m.kind === 'pass') return null
      if (m.author === 'user') return <li key={m.messageId} className="hx-room__msg hx-room__msg--me"><p>{m.text}</p></li>
      if (m.author === 'host') {
        if (m.kind === 'task_started') return <li key={m.messageId} className="hx-room__task hx-gl"><span><b>Task started</b><small>{m.text}</small></span>
          {m.taskId ? <button type="button" className="hx-agbtn" onClick={() => onOpenTask(m.taskId!)}>Open task</button> : null}</li>
        return <li key={m.messageId} className="hx-room__notice">{m.text}</li>
      }
      const agent = byId.get(m.author)
      return <li key={m.messageId} className="hx-room__msg">
        {agent ? <Avatar avatar={agent.avatar} size={28} /> : <span className="hx-room__gone" aria-hidden />}
        <div><span className="hx-room__who"><b>{agent ? agent.name : 'Removed agent'}</b>{m.kind === 'propose_task' ? <small>Proposed a task</small> : null}</span><p>{m.text}</p></div></li>
    })}
    {speaker ? <li className="hx-room__notice" role="status">{speaker.name} is replying…</li> : null}
  </ol>
}

/**
 * A team's chat room. Members reply in turn after each message; when they agree on
 * work, one team task starts automatically and still goes through approval.
 */
export function TeamRoom({ api, teamId, agents, archived, onOpenTask }: { api: RoomApi; teamId: string; agents: Named[]; archived: boolean; onOpenTask: (taskId: string) => void }) {
  const [state, setState] = useState<{ messages: RoomMessage[]; round: RoomRound }>({ messages: [], round: IDLE })
  const [draft, setDraft] = useState(''), [err, setErr] = useState<string | null>(null), [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    const off = api.onRoomEvent((event) => { if (live) setState((s) => applyRoomEvent(s, teamId, event)) })
    api.getRoom(teamId).then((r) => { if (live) setState((s) => ({ round: r.round, messages: [...r.messages, ...s.messages.filter((m) => !r.messages.some((x) => x.messageId === m.messageId))] })) })
      .catch((e) => { if (live) setErr(errText(e)) })
    return () => { live = false; off() }
  }, [api, teamId])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }) }, [state.messages.length])
  const send = async () => {
    const text = draft.trim()
    if (!text || sending || archived) return
    setSending(true); setErr(null)
    try { await api.postRoomMessage({ teamId, text }); setDraft('') } catch (e) { setErr(errText(e)) } finally { setSending(false) }
  }
  const stop = async () => { try { await api.stopRoomRound(teamId) } catch (e) { setErr(errText(e)) } }
  return <section className="hx-room hx-gl" aria-label="Team room">
    {state.messages.length ? <RoomTranscript messages={state.messages} agents={agents} round={state.round} onOpenTask={onOpenTask} />
      : <p className="hx-ag__empty">Ask the team something. Members reply in turn.</p>}
    <div ref={end} />
    <p className="hx-ag__note">When the team agrees on work, it starts one task automatically. Anything with an effect still needs your approval.</p>
    {err ? <p className="hx-ag__err" role="alert">{err}</p> : null}
    <div className="hx-room__compose">
      <textarea className="hx-fld__in" rows={2} value={draft} maxLength={LIM.message} disabled={archived} aria-label="Message to the team"
        placeholder={archived ? 'This team is archived' : 'Message the team'} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
      {state.round.active ? <button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => void stop()}>Stop</button> : null}
      <button type="button" className="hx-agbtn hx-agbtn--p" disabled={archived || sending || !draft.trim()} onClick={() => void send()}>Send</button>
    </div>
  </section>
}
