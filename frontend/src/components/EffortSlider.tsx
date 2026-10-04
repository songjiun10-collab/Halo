import { useRef, useState, type PointerEvent } from 'react'
import { effortLabel, PLANNER_EFFORTS, type PlannerEffort } from '../session/planner-effort'

// Fixed sparkle positions for the Ultra track (percent of width/height).
const STARS = [[8, 30], [15, 70], [24, 40], [33, 78], [41, 22], [49, 60], [56, 35], [63, 72], [71, 28], [78, 55], [86, 75], [92, 38]]
const LAST = PLANNER_EFFORTS.length - 1
const clamp = (f: number) => Math.min(1, Math.max(0, f))

/** The level nearest a position along the track (0 = start, 1 = end). */
export function effortAtFraction(fraction: number): PlannerEffort {
  return PLANNER_EFFORTS[Math.round(clamp(fraction) * LAST)]
}

interface Props {
  value: PlannerEffort
  onChange: (effort: PlannerEffort) => void
  /** The level under the pointer while dragging, then null when the drag ends. */
  onPreview?: (effort: PlannerEffort | null) => void
  disabled?: boolean
  naming?: 'codex' | 'claude'
}

/**
 * The planner effort track (Codex-app style): one dot per host level and a round knob; Max flows
 * rainbow, Ultra sparkles purple. The knob follows the pointer while dragging and the level is
 * saved once, snapped to the nearest step, when the pointer is released.
 */
export function EffortSlider({ value, onChange, onPreview, disabled, naming = 'codex' }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const index = Math.max(0, PLANNER_EFFORTS.indexOf(value))
  const shown = drag === null ? PLANNER_EFFORTS[index] : effortAtFraction(drag)
  const at = (i: number) => `${(i / LAST) * 100}%`
  const pick = (effort: PlannerEffort) => { if (!disabled && effort !== value) onChange(effort) }
  const fractionAt = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect()
    return box && box.width > 0 ? clamp((clientX - box.left) / box.width) : index / LAST
  }
  const move = (fraction: number) => { setDrag(fraction); onPreview?.(effortAtFraction(fraction)) }
  const end = (commit: boolean, clientX: number) => {
    if (drag === null) return
    setDrag(null)
    onPreview?.(null)
    if (commit) pick(effortAtFraction(fractionAt(clientX)))
  }
  const handlers = disabled ? {} : {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); move(fractionAt(e.clientX)) },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => { if (drag !== null) move(fractionAt(e.clientX)) },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => end(true, e.clientX),
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => end(false, e.clientX),
  }
  // Knob centre along the track; the fill (blue, rainbow at Max) runs from the track's start to under the knob.
  const knob = drag === null ? at(index) : `${Number((drag * 100).toFixed(2))}%`
  return <div className="hx-effort" data-level={shown} data-dragging={drag === null ? undefined : true}>
    <div ref={trackRef} className="hx-effort__track" {...handlers}>
      {shown === 'ultra' ? <span className="hx-effort__stars" aria-hidden="true">{STARS.map(([x, y], i) => <i key={i} style={{ left: `${x}%`, top: `${y}%` }} />)}</span> : null}
      {PLANNER_EFFORTS.map((level, i) => <span key={level} className="hx-effort__dot" style={{ left: at(i) }} data-ahead={i > PLANNER_EFFORTS.indexOf(shown) || undefined} title={effortLabel(level, naming)} />)}
      {shown !== 'ultra' ? <span className="hx-effort__fill" aria-hidden="true" style={{ width: `calc(${knob} + 34px)` }} /> : null}
      <span className="hx-effort__knob" style={{ left: knob }} />
      <input type="range" min="0" max={LAST} step="1" value={index} aria-label="Effort" aria-valuetext={effortLabel(PLANNER_EFFORTS[index], naming)} disabled={disabled} onChange={(e) => pick(PLANNER_EFFORTS[Number(e.target.value)])} />
    </div>
  </div>
}
