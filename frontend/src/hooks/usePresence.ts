import { useEffect, useState } from 'react'

/** How long an element stays mounted after it's dismissed, so it can animate out. Matches --exit. */
export const EXIT_MS = 150

/**
 * Keeps the last non-null value mounted for EXIT_MS after it goes away, so it can
 * animate out instead of vanishing. `leaving` is true during that window.
 */
export function usePresence<T>(value: T | null | undefined): { item: T | null; leaving: boolean } {
  const [item, setItem] = useState<T | null>(value ?? null)
  const [prev, setPrev] = useState<T | null | undefined>(value)
  // Adopt a new value during render (React's "adjust state when a prop changes" pattern).
  if (value !== prev) {
    setPrev(value)
    if (value != null) setItem(value)
  }
  const leaving = value == null && item != null
  useEffect(() => {
    if (!leaving) return
    const id = window.setTimeout(() => setItem(null), EXIT_MS)
    return () => window.clearTimeout(id)
  }, [leaving])
  return { item: value ?? item, leaving }
}
