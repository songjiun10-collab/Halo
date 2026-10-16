import { PLANNER_EFFORTS, type PlannerEffort } from './planner-effort'

export const effortLast = PLANNER_EFFORTS.length - 1
export const clampFraction = (f: number) => Math.min(1, Math.max(0, f))

/** The level nearest a position along the track (0 = start, 1 = end). */
export function effortAtFraction(fraction: number): PlannerEffort {
  return PLANNER_EFFORTS[Math.round(clampFraction(fraction) * effortLast)]
}
