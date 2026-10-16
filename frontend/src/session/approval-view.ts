import { host } from './session'

export const approvalKey = (a: { taskId: string; id: string }) => `${a.taskId}:${a.id}`
export const lendSummary = (offer: { action: string; origin: string }, t: { minutes: number; uses: number }) =>
  `${offer.action} · ${host(offer.origin)} · ${t.minutes} min · ${t.uses} ${t.uses === 1 ? 'use' : 'uses'}`
