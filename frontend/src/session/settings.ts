import type { HaloBrowserApi, HostSettings } from './api'
import { activeModel, CLAUDE_MODELS } from './claude-models'

export type SettingsPatch = Partial<Omit<HostSettings, 'version'>>

/** Mirror of the host's permission policy (apps/computer-browser/main/harness/permission-policy.js). */
export const PERMISSION_OPTIONS: readonly { value: HostSettings['permissionMode']; label: string; hint: string }[] = [
  { value: 'observe', label: 'Observe', hint: 'Reads and scrolls the page only.' },
  { value: 'browse', label: 'Browse', hint: 'Also opens pages and follows links, each checked by the approver.' },
  { value: 'interact', label: 'Interact', hint: 'Also clicks and types; you approve each one.' },
  { value: 'full', label: 'Full', hint: 'Also submits forms. Skips approval for every allowed action.' },
]

export const EXECUTION_OPTIONS: readonly { value: HostSettings['executionMode']; label: string; hint: string }[] = [
  { value: 'sequential', label: 'One at a time', hint: 'Tasks queue and run in order.' },
  { value: 'parallel', label: 'In parallel', hint: 'Several tasks run at once, within the memory budget.' },
]

/** Where fast mode takes effect for the planner the settings select. */
export function fastModeSupport(settings: HostSettings | null): 'no_planner' | 'codex' | 'claude_opus' | 'claude_other' | 'unsupported' {
  const model = activeModel(settings)
  if (!model) return 'no_planner'
  if (model.provider === 'codex_cli') return 'codex'
  if (model.provider === 'antigravity' || model.provider === 'cursor' || model.provider === 'nvidia' || model.provider === 'opencode_cli') return 'unsupported'
  return CLAUDE_MODELS.some((m) => m.id === model.id && m.family === 'opus') ? 'claude_opus' : 'claude_other'
}

/** One host settings change; null when there is no host or it refused. */
export async function saveSetting(api: Pick<HaloBrowserApi, 'updateHostSettings'> | undefined, patch: SettingsPatch): Promise<HostSettings | null> {
  if (!api) return null
  try {
    return await api.updateHostSettings(patch)
  } catch {
    return null
  }
}
