import type { TimelineEvent } from './types'

export interface WorkSummary { seconds: number; steps: number; events: TimelineEvent[] }

/** How long the agent has been working and what it did, from the journal timeline. */
export function workSummary(timeline: TimelineEvent[]): WorkSummary | null {
  const times = timeline.flatMap((e) => { const t = e.at ? Date.parse(e.at) : NaN; return Number.isFinite(t) ? [t] : [] })
  if (times.length === 0) return null
  const events = timeline.filter((e) => !e.notable)
  return { seconds: Math.max(0, Math.round((Math.max(...times) - Math.min(...times)) / 1000)), steps: events.length, events }
}

export function workedForLabel({ seconds, steps }: WorkSummary): string {
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  return `Worked for ${time} · ${steps} ${steps === 1 ? 'step' : 'steps'}`
}
