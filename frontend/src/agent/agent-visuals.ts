import type { AvatarColor, AvatarShape } from './agent-api'
import { PLANNER_MODELS } from '../session/claude-models'
import type { AgentBrand } from './AgentUi'

export const SHAPES: AvatarShape[] = ['circle', 'square', 'bag', 'star', 'drop', 'cloud', 'triangle', 'hex']
export const COLORS: Record<AvatarColor, string> = { brown: 'oklch(.5 .07 55)', yellow: 'oklch(.84 .15 95)', blue: 'oklch(.66 .15 250)', gray: 'oklch(.64 .02 150)', red: 'oklch(.64 .19 25)', green: 'oklch(.7 .14 155)', purple: 'oklch(.64 .16 305)', orange: 'oklch(.73 .17 55)' }

export const modelBrand = (model: string | null | undefined): AgentBrand | undefined => PLANNER_MODELS.find((m) => m.id === model)?.provider
