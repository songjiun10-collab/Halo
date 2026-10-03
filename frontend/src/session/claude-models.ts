import type { HaloBrowserApi, HostSettings } from './api'

export interface ClaudeModel { id: string; label: string; family: 'opus' | 'sonnet' | 'haiku' | 'fable'; legacy: boolean }
export interface PlannerModel { id: string; label: string; legacy: boolean; provider: 'claude_code' | 'codex_cli' | 'antigravity' | 'cursor' | 'nvidia' | 'opencode_cli'; description?: string }

/** Mirror of the host allowlist (apps/computer-browser/main/harness/providers/claude-models.js); the host re-validates every id. */
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', legacy: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', legacy: false },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', family: 'haiku', legacy: false },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', legacy: false },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5', family: 'opus', legacy: true },
  { id: 'claude-opus-4-1-20250805', label: 'Opus 4.1', family: 'opus', legacy: true },
  { id: 'claude-opus-4-20250514', label: 'Opus 4', family: 'opus', legacy: true },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', family: 'sonnet', legacy: true },
  { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4', family: 'sonnet', legacy: true },
  { id: 'claude-3-7-sonnet-20250219', label: 'Sonnet 3.7', family: 'sonnet', legacy: true },
  { id: 'claude-3-5-haiku-20241022', label: 'Haiku 3.5', family: 'haiku', legacy: true },
]
/** Mirror of the host Codex allowlist (apps/computer-browser/main/harness/providers/codex-models.js). */
export const CODEX_MODELS: readonly { id: string; label: string; legacy: boolean; description: string }[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', legacy: false, description: 'Latest workhorse model for coding and everyday work.' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', legacy: false, description: 'Frontier intelligence for the most demanding work.' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', legacy: false, description: 'Previous generation workhorse model.' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', legacy: false, description: 'Fast and affordable model for easier tasks.' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', legacy: true, description: 'Older generation workhorse model.' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', legacy: true, description: 'Older balanced model for straightforward work.' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', legacy: true, description: 'Older fast and efficient model.' },
  { id: 'gpt-5.5', label: 'GPT-5.5', legacy: true, description: 'Legacy coding model.' },
]
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol'
export const NVIDIA_MODELS = [
  { id: 'deepseek-ai/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-ai/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super' },
] as const
export const DEFAULT_NVIDIA_MODEL = NVIDIA_MODELS[0].id

/** Every selectable planner model, tagged with the provider that runs it. */
export const PLANNER_MODELS: readonly PlannerModel[] = [
  ...NVIDIA_MODELS.map((m) => ({ ...m, legacy: false, provider: 'nvidia' as const })),
  ...CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label, legacy: m.legacy, provider: 'claude_code' as const })),
  ...CODEX_MODELS.map((m) => ({ ...m, provider: 'codex_cli' as const })),
  { id: 'antigravity-default', label: 'Antigravity default', legacy: false, provider: 'antigravity', description: 'Isolated agy CLI. Requires GEMINI_API_KEY; desktop login is not inherited.' },
  { id: 'cursor-auto', label: 'Cursor Auto', legacy: false, provider: 'cursor', description: 'Isolated Cursor CLI. Requires CURSOR_API_KEY; desktop login is not inherited.' },
  { id: 'opencode-default', label: 'OpenCode default', legacy: false, provider: 'opencode_cli', description: 'Uses the model and provider already selected in OpenCode.' },
]

/** What an unset plannerModel runs (the CLI's latest Opus). */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

/** The model the selected planner runs, or null while no planner is selected. */
export function activeModel(settings: HostSettings | null): PlannerModel | null {
  const provider = settings?.plannerProvider
  if (!provider || provider === 'none') return null
  const defaults = { claude_code: DEFAULT_CLAUDE_MODEL, codex_cli: DEFAULT_CODEX_MODEL, antigravity: 'antigravity-default', cursor: 'cursor-auto', nvidia: DEFAULT_NVIDIA_MODEL, opencode_cli: 'opencode-default' }
  const id = settings?.plannerModel ?? defaults[provider]
  return PLANNER_MODELS.find((m) => m.id === id && m.provider === provider) ?? null
}

/** Turn on the planner that runs one allowlisted model, pinned to it; null if unknown or the host refuses. */
export async function saveModel(api: Pick<HaloBrowserApi, 'updateHostSettings'> | undefined, id: string): Promise<HostSettings | null> {
  const model = PLANNER_MODELS.find((m) => m.id === id)
  if (!api || !model) return null
  try {
    return await api.updateHostSettings({ plannerProvider: model.provider, plannerModel: id })
  } catch {
    return null
  }
}
