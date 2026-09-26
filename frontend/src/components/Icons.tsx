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

export const Play = () => <Icon><path d="M8 5.5v13l10-6.5z" /></Icon>
export const Check = () => <Icon><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>
export const Pause = () => <Icon><path d="M9 5v14M15 5v14" /></Icon>
export const Hand = () => <Icon><path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.6L4 15a1.5 1.5 0 0 1 2.4-1.8L8 15" /></Icon>
export const Share = () => <Icon><path d="M12 15V4M8 8l4-4 4 4" /><path d="M6 11H5v9h14v-9h-1" /></Icon>
export const Tabs = () => <Icon><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Icon>
export const NewWindow = () => <Icon><rect x="3" y="5" width="15" height="13" rx="2" /><path d="M3 9h15" /><path d="M20 3v6M17 6h6" /></Icon>
