import type { Verdict } from '../session/types'
import { Check, Close, Lock, Pause } from './Icons'

const glyph = { allow: Check, review: Pause, deny: Close, quarantine: Lock } as const

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const Glyph = glyph[verdict]
  return (
    <span className={`hx-verdict hx-verdict--${verdict}`}>
      <Glyph /> {verdict}
    </span>
  )
}
