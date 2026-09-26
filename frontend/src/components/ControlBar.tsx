import { AGENT, controlLabel } from '../session/session'
import type { Control } from '../session/types'
import { Hand, Play } from './Icons'

interface Props {
  control: Control
  finished: boolean
  onTakeControl: () => void
  onResume: () => void
}

/** Who drives the browser, stated at the top, with the one way to change it. */
export function ControlBar({ control, finished, onTakeControl, onResume }: Props) {
  return (
    <div className="hx-control" data-control={control}>
      <span className="hx-control__state">
        <span className="hx-control__dot" aria-hidden="true" />
        {controlLabel[control]}
      </span>
      {control !== 'you' && (
        <button className="hx-btn hx-btn--secondary hx-btn--compact" onClick={onTakeControl}><Hand />Take control</button>
      )}
      {control === 'you' && !finished && (
        <button className="hx-btn hx-btn--secondary hx-btn--compact" onClick={onResume}><Play />Resume {AGENT}</button>
      )}
      {control === 'you' && finished && <span className="hx-control__note">{AGENT} finished</span>}
    </div>
  )
}
