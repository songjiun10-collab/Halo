import type { IntentLockInput } from './api'
import type { LockChip } from '../components/LockChips'

export function lockFromChips(chips: ReadonlySet<LockChip>, pageUrl?: string): IntentLockInput | undefined {
  const rules: IntentLockInput['rules'] = []
  if (chips.has('no_navigate')) rules.push({ kind: 'deny_action', action: 'navigate' })
  if (chips.has('no_links')) rules.push({ kind: 'deny_action', action: 'follow_link' })
  if (chips.has('this_site') && pageUrl) {
    try { rules.push({ kind: 'allow_origins', origins: [new URL(pageUrl).origin] }) } catch { /* no site to pin */ }
  }
  return rules.length ? { rules } : undefined
}
