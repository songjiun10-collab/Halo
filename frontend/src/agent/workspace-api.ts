/** Host APIs for usage, custom memory and saved routines (preload `HARNESS_METHODS`). The host re-validates every input. */

export type UsageProvider = 'claude' | 'codex'
export interface UsageTotals { calls?: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number; durationMs?: number }
export interface PlanWindow { usedPercent: number; resetsAt?: string | number | null; windowMinutes?: number }
export interface SubscriptionSnapshot { provider: UsageProvider; windows: Record<string, PlanWindow | null>; asOf?: number }
export interface UsageLimitStatus { limit: { tokens: number | null; costUsd: number | null }; exceeded: boolean; basis: 'imported' | 'harness'; remainingTokens?: number; tokensUsedRatio?: number; remainingCostUsd?: number; costUsedRatio?: number }
export interface UsageSummary {
  byProvider: Record<UsageProvider, UsageTotals>
  imported: Partial<Record<UsageProvider, UsageTotals & { sessions: number; syncedAt?: number }>>
  subscription: Partial<Record<UsageProvider, SubscriptionSnapshot>>
  limits: Record<UsageProvider, UsageLimitStatus>
}
export interface UsageSyncResult { results: Record<string, { status: string; sessions?: number }>; usage: UsageSummary }
export interface MemoryEntry { id: string; text: string; origin: string | null; createdAt: string; updatedAt: string }
export type RoutineStep = { kind: 'navigate'; url: string } | { kind: 'follow_link'; name: string; expectedHref?: string } | { kind: 'scroll'; direction: 'up' | 'down'; amount?: number }
export interface RoutineRecord { schemaVersion: number; routineId: string; revision: number; name: string; description: string; origins: string[]; steps: RoutineStep[]; createdAt: string; updatedAt: string; digest: string }
export interface RoutineInput { routineId?: string; name: string; description: string; origins: string[]; steps: RoutineStep[] }

export interface WorkspaceApi {
  getUsage(): Promise<UsageSummary>
  setUsageLimit(provider: UsageProvider, patch: { tokens?: number | null; costUsd?: number | null }): Promise<UsageSummary>
  syncUsage(): Promise<UsageSyncResult>
  listMemories(): Promise<MemoryEntry[]>
  saveMemory(input: { id?: string; text: string; origin?: string | null }): Promise<MemoryEntry>
  removeMemory(id: string): Promise<boolean>
  listRoutines(): Promise<RoutineRecord[]>
  saveRoutine(input: RoutineInput): Promise<RoutineRecord>
  deleteRoutine(routineId: string): Promise<unknown>
  runRoutine(routineId: string, revision: number): Promise<{ taskId: string }>
}

const has = (o: unknown, names: string[]) => !!o && names.every((n) => typeof (o as Record<string, unknown>)[n] === 'function')
/** Each section shows only when the preload exposes its methods. */
export const workspaceApi = () => (typeof window === 'undefined' ? undefined : (window.haloBrowser as unknown as WorkspaceApi | undefined))
export const canUsage = (api: unknown) => has(api, ['getUsage', 'setUsageLimit', 'syncUsage'])
export const canMemory = (api: unknown) => has(api, ['listMemories', 'saveMemory', 'removeMemory'])
export const canRoutines = (api: unknown) => has(api, ['listRoutines', 'saveRoutine', 'deleteRoutine', 'runRoutine'])

export const MEMORY_LIMIT = 100
export const PROVIDER_LABEL: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' }
const WINDOW_LABEL: Record<string, string> = { session: 'Current session', week: 'This week', weekSonnet: 'This week · Sonnet', weekOpus: 'This week · Opus' }

export interface UsageRow { provider: UsageProvider; label: string; basis: 'imported' | 'harness'; sessions?: number; tokens: number; costUsd: number; windows: { label: string; usedPercent: number; resetsAt: string | null }[]; limit: UsageLimitStatus['limit']; exceeded: boolean; usedRatio: number | null }

function windowLabel(key: string, w: PlanWindow) {
  if (WINDOW_LABEL[key]) return WINDOW_LABEL[key]
  const m = w.windowMinutes
  if (m && m % 1440 === 0) return m === 10080 ? 'Weekly window' : `${m / 1440}d window`
  if (m && m % 60 === 0) return `${m / 60}h window`
  return m ? `${m}m window` : key === 'primary' ? 'Short window' : 'Long window'
}
function resetText(v: PlanWindow['resetsAt']) {
  if (v === null || v === undefined) return null
  // Codex reports seconds since the epoch; Claude an ISO string.
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** One row per provider. The CLI-imported totals win over HALO's own counts, matching how the host checks limits. */
export function usageRows(u: UsageSummary): UsageRow[] {
  return (['claude', 'codex'] as const).map((p) => {
    const imported = u.imported?.[p]
    const used = imported ?? u.byProvider?.[p] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }
    const status = u.limits?.[p] ?? { limit: { tokens: null, costUsd: null }, exceeded: false, basis: 'harness' as const }
    const windows = Object.entries(u.subscription?.[p]?.windows ?? {}).flatMap(([k, w]) => (w && Number.isFinite(w.usedPercent) ? [{ label: windowLabel(k, w), usedPercent: w.usedPercent, resetsAt: resetText(w.resetsAt) }] : []))
    const ratios = [status.tokensUsedRatio, status.costUsedRatio].filter((r): r is number => typeof r === 'number')
    return { provider: p, label: PROVIDER_LABEL[p], basis: imported ? 'imported' : 'harness', sessions: imported?.sessions, tokens: used.inputTokens + used.outputTokens, costUsd: used.costUsd, windows, limit: status.limit, exceeded: status.exceeded, usedRatio: ratios.length ? Math.max(...ratios) : null }
  })
}

export function formatTokens(n: number) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`
  return String(n)
}
export const formatUsd = (n: number) => `$${n.toFixed(2)}`

function positive(text: string, label: string) {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number, or blank for no limit.`)
  return n
}
/** Blank clears that limit. */
export function limitPatch(tokens: string, costUsd: string) {
  return { tokens: positive(tokens, 'Token limit'), costUsd: positive(costUsd, 'Cost limit') }
}

export type StepDraft = { kind: 'navigate'; url: string } | { kind: 'follow_link'; name: string; expectedHref: string } | { kind: 'scroll'; direction: 'up' | 'down'; amount: string }
export interface RoutineDraft { routineId?: string; name: string; description: string; steps: StepDraft[] }

export const blankStep = (kind: StepDraft['kind']): StepDraft => (kind === 'navigate' ? { kind, url: '' } : kind === 'follow_link' ? { kind, name: '', expectedHref: '' } : { kind, direction: 'down', amount: '' })
export const blankRoutine = (): RoutineDraft => ({ name: '', description: '', steps: [blankStep('navigate')] })

function httpOrigin(value: string, label: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error(`${label} must be a full URL.`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} must start with http:// or https://.`)
  return url.origin
}

/** Builds the host's save input. The origin allowlist is every origin the steps visit, so a run cannot leave those sites. */
export function routineInput(d: RoutineDraft): RoutineInput {
  const name = d.name.trim()
  if (!name) throw new Error('Give the routine a name.')
  const origins: string[] = []
  const add = (o: string) => { if (!origins.includes(o)) origins.push(o) }
  const steps = d.steps.map((s, i): RoutineStep => {
    const label = `Step ${i + 1}`
    if (s.kind === 'navigate') { add(httpOrigin(s.url, `${label} URL`)); return { kind: 'navigate', url: s.url.trim() } }
    if (s.kind === 'follow_link') {
      if (!s.name.trim()) throw new Error(`${label} needs the link text.`)
      if (!s.expectedHref.trim()) return { kind: 'follow_link', name: s.name.trim() }
      add(httpOrigin(s.expectedHref, `${label} link URL`))
      return { kind: 'follow_link', name: s.name.trim(), expectedHref: s.expectedHref.trim() }
    }
    if (!s.amount.trim()) return { kind: 'scroll', direction: s.direction }
    const amount = Number(s.amount)
    if (!Number.isInteger(amount) || amount < 1 || amount > 20000) throw new Error(`${label} scroll amount must be 1–20000 pixels.`)
    return { kind: 'scroll', direction: s.direction, amount }
  })
  if (!origins.length) throw new Error('Add a Navigate step so the routine knows which site it runs on.')
  return { ...(d.routineId ? { routineId: d.routineId } : {}), name, description: d.description.trim(), origins, steps }
}

export function routineDraft(r: RoutineRecord): RoutineDraft {
  return {
    routineId: r.routineId, name: r.name, description: r.description,
    steps: r.steps.map((s): StepDraft => (s.kind === 'navigate' ? { ...s } : s.kind === 'follow_link' ? { kind: s.kind, name: s.name, expectedHref: s.expectedHref ?? '' } : { kind: s.kind, direction: s.direction, amount: s.amount === undefined ? '' : String(s.amount) })),
  }
}

/** Null when the draft can be saved, else what is missing. */
export function routineProblem(d: RoutineDraft) {
  try { routineInput(d); return null } catch (e) { return (e as Error).message }
}
