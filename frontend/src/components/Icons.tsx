/** Outline icons on Phosphor-regular geometry (24px grid). Stroke follows the text beside them via CSS. */
import type { ReactNode } from 'react'

const Icon = ({ children }: { children: ReactNode }) => (
  <svg className="hx-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{children}</svg>
)

export const Back = () => <Icon><path d="M20 12H4M10 6l-6 6 6 6" /></Icon>
export const Forward = () => <Icon><path d="M4 12h16M14 6l6 6-6 6" /></Icon>
export const Lock = () => <Icon><rect x="5" y="10" width="14" height="10" rx="1.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Icon>
export const Close = () => <Icon><path d="M6 6l12 12M18 6L6 18" /></Icon>
export const Plus = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>
export const PauseCircle = () => <Icon><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></Icon>
export const Play = () => <Icon><path d="M8 5.5v13l10-6.5z" /></Icon>
export const Check = () => <Icon><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>
export const Pause = () => <Icon><path d="M9 5v14M15 5v14" /></Icon>
