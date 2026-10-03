import type { ReactNode } from 'react'
import type { Avatar as AvatarT, AvatarColor, AvatarShape, AgentRecord } from './agent-api'
import { ago, statusLabel, type UiConversation } from './normalize'
import { PLANNER_MODELS } from '../session/claude-models'

export const SHAPES: AvatarShape[] = ['circle', 'square', 'bag', 'star', 'drop', 'cloud', 'triangle', 'hex']
export const COLORS: Record<AvatarColor, string> = { brown: 'oklch(.5 .07 55)', yellow: 'oklch(.84 .15 95)', blue: 'oklch(.66 .15 250)', gray: 'oklch(.64 .02 150)', red: 'oklch(.64 .19 25)', green: 'oklch(.7 .14 155)', purple: 'oklch(.64 .16 305)', orange: 'oklch(.73 .17 55)' }
export type AgentBrand = 'claude_code' | 'codex_cli' | 'antigravity' | 'cursor' | 'nvidia'
export const modelBrand = (model: string | null | undefined): AgentBrand | undefined => PLANNER_MODELS.find((m) => m.id === model)?.provider

const AG_INK = '#1d1a17', AG_BLUSH = '#ff8fa3'
const agEye = (x: number, y: number, k: string) => k === 'wink' ? <path d={`M${x - 3.4} ${y}q3.4 -3.6 6.8 0`} fill="none" stroke={AG_INK} strokeWidth="2.4" strokeLinecap="round" /> : k === 'happy' ? <path d={`M${x - 3.4} ${y + 1.2}q3.4 -4.4 6.8 0`} fill="none" stroke={AG_INK} strokeWidth="2.4" strokeLinecap="round" /> : <g><ellipse cx={x} cy={y} rx="3" ry="3.6" fill={AG_INK} /><circle cx={x + 1} cy={y - 1.3} r="1.1" fill="#fff" /></g>
const agMouth = (x: number, y: number, k: string) => k === 'o' ? <ellipse cx={x} cy={y + 1} rx="2.4" ry="3" fill={AG_INK} /> : k === 'grin' ? <path d={`M${x - 5} ${y - 1}q5 8 10 0z`} fill={AG_INK} stroke={AG_INK} strokeWidth="1.6" strokeLinejoin="round" /> : k === 'flat' ? <path d={`M${x - 3} ${y + 1}h6`} stroke={AG_INK} strokeWidth="2.2" strokeLinecap="round" /> : <path d={`M${x - 4} ${y}q4 5 8 0`} fill="none" stroke={AG_INK} strokeWidth="2.4" strokeLinecap="round" />
const agFace = (cx: number, cy: number, o: { gap?: number; eye?: string[]; mouth?: string } = {}) => { const g = o.gap || 9, e = o.eye || ['dot', 'dot']; return <g>{agEye(cx - g, cy, e[0])}{agEye(cx + g, cy, e[1])}<ellipse cx={cx - g - 5} cy={cy + 7} rx="4" ry="2.5" fill={AG_BLUSH} opacity=".7" /><ellipse cx={cx + g + 5} cy={cy + 7} rx="4" ry="2.5" fill={AG_BLUSH} opacity=".7" />{agMouth(cx, cy + 8, o.mouth || 'smile')}</g> }

/** Design System-6 faced characters: same 8 shape ids and 8 colours, so stored avatars are unchanged. */
export function Shape({ shape, color, size = 24 }: { shape: AvatarShape; color: AvatarColor; size?: number }) {
  const c = COLORS[color] ?? COLORS.gray, d = `color-mix(in oklab, ${c} 55%, #000)`, p = { fill: c, stroke: c, strokeLinejoin: 'round' as const }
  const el: Record<AvatarShape, ReactNode> = {
    circle: <g><circle cx="40" cy="42" r="28" fill={c} />{agFace(40, 40)}</g>,
    square: <g><rect x="13" y="14" width="54" height="54" rx="15" fill={c} />{agFace(40, 40, { eye: ['dot', 'wink'], mouth: 'grin' })}</g>,
    bag: <g><path d="M29 28v-4a11 11 0 0122 0v4" fill="none" stroke={d} strokeWidth="5" strokeLinecap="round" /><path d="M14 28h52l-3 38a6 6 0 01-6 5H23a6 6 0 01-6-5z" fill={c} />{agFace(40, 46, { mouth: 'o' })}</g>,
    star: <g><path d="M40 8l9 19.5 21 2.6-15.5 14.6 4 21L40 55.5 21.5 65.7l4-21L10 30.1l21-2.6z" {...p} strokeWidth="8" />{agFace(40, 40, { gap: 8, eye: ['happy', 'happy'], mouth: 'grin' })}</g>,
    drop: <g><path d="M40 8C40 8 15 36 15 52a25 25 0 0050 0C65 36 40 8 40 8z" fill={c} />{agFace(40, 50)}</g>,
    cloud: <g><path d="M24 62a14 14 0 01-2-27.8A18 18 0 0156 30a16 16 0 013 32z" fill={c} />{agFace(41, 46, { mouth: 'flat' })}</g>,
    triangle: <g><path d="M40 12L68 62Q70 68 63 68H17Q10 68 12 62z" {...p} strokeWidth="8" />{agFace(40, 48, { gap: 8, mouth: 'o' })}</g>,
    hex: <g><path d="M40 8l27 15.5v31L40 70 13 54.5v-31z" {...p} strokeWidth="6" />{agFace(40, 40, { eye: ['wink', 'dot'] })}</g>,
  }
  return <svg viewBox="0 0 80 80" width={size} height={size} aria-hidden="true">{el[shape] ?? null}</svg>
}
/** Orchestrator mark: blue circle + halo. Heads the sub-task plan. */
export function OrchestratorMark({ size = 36 }: { size?: number }) {
  return <svg viewBox="0 0 80 80" width={size} height={size} aria-hidden="true"><circle cx="40" cy="46" r="25" fill="oklch(.66 .15 250)" /><ellipse cx="40" cy="17" rx="15" ry="4.8" fill="none" stroke="oklch(.84 .15 95)" strokeWidth="4.2" transform="rotate(-6 40 17)" />{agFace(40, 44, { gap: 9 })}</svg>
}
export function Avatar({ avatar, size = 44, ring, brand }: { avatar: AvatarT; size?: number; ring?: boolean; brand?: AgentBrand }) {
  const c = COLORS[avatar.color] ?? COLORS.gray
  const icon = brand === 'codex_cli' ? 'codex' : brand === 'claude_code' ? 'claude' : null
  return <span className="hx-av" data-brand={brand} style={{ width: size, height: size, background: `color-mix(in oklab, ${c} 24%, transparent)`, boxShadow: ring ? '0 0 0 2px var(--backdrop)' : undefined }}><Shape shape={avatar.shape} color={avatar.color} size={size * 0.82} />{icon ? <img className="hx-av__brand" src={`./assets/model-icons/${icon}.png`} alt="" /> : null}</span>
}

export type AgentCharacterState = 'idle' | 'working' | 'attention' | 'result'
const CHARACTER_COPY: Record<AgentCharacterState, string> = { idle: 'Idle', working: 'Working', attention: 'Needs you', result: 'New result' }

/** Explicitly credits the project whose interaction pattern informed this feature. */
export function AgentDeskCredit() {
  return <a className="hx-desk__credit" href="https://github.com/rullerzhou-afk/clawd-on-desk" target="_blank" rel="noreferrer">State-animation inspiration: Clawd on Desk</a>
}

/** Original Halo desk character; brand only selects an abstract color/silhouette, never upstream character art. */
export function AgentCharacter({ brand, state, size = 34 }: { brand?: AgentBrand; state: AgentCharacterState; size?: number }) {
  const provider = brand ?? 'halo'
  const brandName = brand ? ({ claude_code: 'Claude Code', codex_cli: 'Codex CLI', antigravity: 'Antigravity', cursor: 'Cursor', nvidia: 'NVIDIA' })[brand] : 'Halo'
  return <span className="hx-agent-character" data-brand={provider} data-state={state} style={{ width: size, height: size }} role="img" aria-label={`${brandName} · ${CHARACTER_COPY[state]}`}>
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      {brand === 'claude_code' ? <>
        <path d="M13 17 9 10l9 3q6-4 12 0l9-3-4 9v14q0 5-5 5H18q-5 0-5-5z" fill="currentColor" />
        <circle cx="19" cy="23" r="2" className="hx-agent-character__eye" /><circle cx="29" cy="23" r="2" className="hx-agent-character__eye" />
        <path d="M20 29q4 4 8 0" className="hx-agent-character__face" />
      </> : brand === 'codex_cli' ? <>
        <path d="M16 9h16l7 7v17l-7 7H16l-7-7V16z" fill="currentColor" />
        <path d="M19 21h1v3h-1zm9 0h1v3h-1z" className="hx-agent-character__eye" />
        <path d="M20 30h8" className="hx-agent-character__face" />
        <path d="M7 18h4M37 30h4" className="hx-agent-character__detail" />
      </> : <>
        <circle cx="24" cy="25" r="15" fill="currentColor" />
        <ellipse cx="24" cy="8" rx="10" ry="3" className="hx-agent-character__halo" />
        <circle cx="19" cy="24" r="2" className="hx-agent-character__eye" /><circle cx="29" cy="24" r="2" className="hx-agent-character__eye" />
        <path d="M20 30q4 4 8 0" className="hx-agent-character__face" />
      </>}
    </svg>
  </span>
}

export const Ic = ({ d, s = 15 }: { d: string; s?: number }) => <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>

export function Stack({ ids, agents }: { ids: string[]; agents: AgentRecord[] }) {
  const m = ids.map((i) => agents.find((a) => a.id === i)).filter(Boolean) as AgentRecord[]
  return <span className="hx-stack">{m.slice(0, 4).map((a, i) => <span key={a.id} style={{ marginLeft: i ? -10 : 0, zIndex: 9 - i }}><Avatar avatar={a.avatar} size={30} ring /></span>)}{m.length > 4 ? <span className="hx-stack__n">+{m.length - 4}</span> : null}</span>
}

export function Field({ label, value, onChange, max, multi, rows = 3, hint }: { label: string; value: string; onChange: (v: string) => void; max: number; multi?: boolean; rows?: number; hint?: string }) {
  const over = value.length > max
  const common = { className: 'hx-fld__in', value, 'aria-invalid': over || undefined, onChange: (e: { target: { value: string } }) => onChange(e.target.value) }
  return <label className="hx-fld"><span className="hx-fld__top"><b>{label}</b><small data-over={over || undefined}>{value.length}/{max}</small></span>{multi ? <textarea rows={rows} {...common} /> : <input {...common} />}{hint ? <em>{hint}</em> : null}</label>
}

export function ConvoList({ rows, owners, onOpen, showOwner }: { rows: UiConversation[]; owners: Record<string, { name: string; avatar: AvatarT }>; onOpen: (c: UiConversation) => void; showOwner?: boolean }) {
  if (!rows.length) return <p className="hx-ag__empty">No conversations yet.</p>
  return <ul className="hx-convos">{rows.map((c) => { const o = owners[c.ownerId], gone = !c.task
    return <li key={c.taskId}><button type="button" className="hx-convo" disabled={gone} data-gone={gone || undefined} onClick={() => onOpen(c)}>
      {showOwner && o ? <Avatar avatar={o.avatar} size={30} /> : null}{c.unread ? <i className="hx-unread" aria-label="Unread" /> : null}
      <span className="hx-convo__t"><b>{c.task ? c.task.title : 'Task record removed'}</b>{showOwner && o ? <small>{o.name}{c.kind === 'team' ? ' · team' : ''}</small> : null}</span>
      {c.task ? <span className="hx-convo__s" data-s={c.task.status}>{statusLabel[c.task.status]}</span> : null}<small className="hx-convo__d">{ago(c.createdAt)}</small></button></li> })}</ul>
}
