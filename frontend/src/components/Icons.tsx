/** Outline icons drawn to Phosphor-regular geometry (24px grid, 1.5px stroke). */
import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="hx-ic" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  )
}

export const Back = () => <Icon><path d="M20 12H4M10 6l-6 6 6 6" /></Icon>
export const Forward = () => <Icon><path d="M4 12h16M14 6l6 6-6 6" /></Icon>
export const Reload = () => <Icon><path d="M20 5v5h-5" /><path d="M19.5 10A8 8 0 1 0 20 14" /></Icon>
export const Lock = () => <Icon><rect x="5" y="10" width="14" height="10" rx="1.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Icon>
export const Close = () => <Icon><path d="M6 6l12 12M18 6L6 18" /></Icon>
export const Plus = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>
export const Stop = () => <Icon><rect x="6" y="6" width="12" height="12" rx="1.5" /></Icon>
export const Play = () => <Icon><path d="M7 5l12 7-12 7z" /></Icon>
export const Check = () => <Icon><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>
export const Pause = () => <Icon><path d="M9 5v14M15 5v14" /></Icon>
