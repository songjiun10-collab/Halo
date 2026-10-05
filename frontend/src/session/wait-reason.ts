// Plain-language reason a queued task has not started. Internal admission codes
// never reach the person; unknown codes fall back to a generic line.
const LABELS: Record<string, string> = {
  behind_queue: 'Waiting for the tasks ahead of it',
  waiting_for_running_task: 'Waiting for the running task to finish',
  memory_budget_exceeded: 'Waiting for memory — close tabs or finish a task to free some',
  memory_pressure_pause: 'Paused while memory is high',
  memory_sample_stale: 'Checking available memory',
  memory_unmeasurable: 'Checking available memory',
  measuring_first_task: 'Waiting for the first task to finish measuring',
  recovered_needs_user: 'Saved from last time — open it to continue',
  shutting_down_previous_task: 'Finishing up the previous task',
}

export function waitReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null
  return LABELS[reason] ?? 'Waiting to start'
}
