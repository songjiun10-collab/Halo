import type { IntentLockInput } from '../session/api'

export type LockChip = 'no_links' | 'no_navigate' | 'this_site'
const CHIPS: { id: LockChip; label: string }[] = [
  { id: 'no_navigate', label: 'Don’t open new pages' },
  { id: 'no_links', label: 'Don’t follow links' },
  { id: 'this_site', label: 'Stay on this site' },
]

/** Host rules for the chosen chips; `this_site` needs the page the task starts from. */
export function lockFromChips(chips: ReadonlySet<LockChip>, pageUrl?: string): IntentLockInput | undefined {
  const rules: IntentLockInput['rules'] = []
  if (chips.has('no_navigate')) rules.push({ kind: 'deny_action', action: 'navigate' })
  if (chips.has('no_links')) rules.push({ kind: 'deny_action', action: 'follow_link' })
  if (chips.has('this_site') && pageUrl) {
    try { rules.push({ kind: 'allow_origins', origins: [new URL(pageUrl).origin] }) } catch { /* no site to pin */ }
  }
  return rules.length ? { rules } : undefined
}

export function LockChips({ value, onChange, pageUrl }: { value: ReadonlySet<LockChip>; onChange: (next: Set<LockChip>) => void; pageUrl?: string }) {
  const toggle = (id: LockChip) => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); onChange(next) }
  return (
    <div className="hx-lockchips" role="group" aria-label="Intent lock">
      <span className="hx-lockchips__label">Enforced by Halo</span>
      {CHIPS.filter((c) => c.id !== 'this_site' || pageUrl).map((c) => (
        <button key={c.id} type="button" className="hx-lockchip" aria-pressed={value.has(c.id)} onClick={() => toggle(c.id)}>{c.label}</button>
      ))}
    </div>
  )
}
