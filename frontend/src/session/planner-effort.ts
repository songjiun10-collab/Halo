import type { HaloBrowserApi, HostSettings } from './api'

export type PlannerEffort = HostSettings['plannerEffort']
export const PLANNER_EFFORTS: readonly PlannerEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export const EFFORT_LEVELS: Record<PlannerEffort, { label: string; tick: string; hint: string }> = {
  low: { label: 'Light', tick: 'Light', hint: 'Fastest, lowest cost. Simple, scoped tasks.' },
  medium: { label: 'Medium', tick: 'Med', hint: 'Balanced. Everyday tasks.' },
  high: { label: 'High', tick: 'High', hint: 'Complex reasoning and agentic work.' },
  xhigh: { label: 'Extra high', tick: 'Extra', hint: 'Long-horizon work. Much more thorough.' },
  max: { label: 'Max', tick: 'Max', hint: 'Deepest reasoning, no limit on spend.' },
  ultra: { label: 'Ultra', tick: 'Ultra', hint: 'Maximum reasoning with automatic task decomposition. Claude runs it as Max.' },
}

/** The host's default effort: Codex's reset target and Claude's Recommended step. */
export const DEFAULT_EFFORT: PlannerEffort = 'medium'

/** Each app names the levels its own way: Codex says Light/Ultra, Claude Code says Low/Ultracode. */
export function effortLabel(effort: PlannerEffort, variant: 'claude' | 'codex'): string {
  if (variant === 'claude' && effort === 'low') return 'Low'
  if (variant === 'claude' && effort === 'ultra') return 'Ultracode'
  return EFFORT_LEVELS[effort]?.label ?? 'Effort'
}

/** Saves the host's planner effort ceiling; null when the level is unknown or the host refused. */
export async function saveEffort(api: Pick<HaloBrowserApi, 'updateHostSettings'> | undefined, effort: string): Promise<HostSettings | null> {
  if (!api || !(PLANNER_EFFORTS as readonly string[]).includes(effort)) return null
  try {
    return await api.updateHostSettings({ plannerEffort: effort as PlannerEffort })
  } catch {
    return null
  }
}
