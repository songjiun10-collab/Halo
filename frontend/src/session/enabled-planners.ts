import { useCallback, useState } from 'react'

const KEY = 'halo.planners.enabled'

/** Providers the user switched on in Settings; null until they first touch a switch (then every provider is offered). */
export function readEnabledPlanners(): string[] | null {
  try {
    const raw = localStorage.getItem(KEY)
    const value = raw ? JSON.parse(raw) : null
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : null
  } catch { return null }
}

export function useEnabledPlanners(): [string[] | null, (next: string[]) => void] {
  const [value, setValue] = useState(readEnabledPlanners)
  const set = useCallback((next: string[]) => {
    setValue(next)
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* the switches still work for this session */ }
  }, [])
  return [value, set]
}
