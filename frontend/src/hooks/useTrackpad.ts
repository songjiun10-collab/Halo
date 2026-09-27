import { useEffect } from 'react'

interface Handlers {
  onBack: () => void
  onForward: () => void
  onToggleOverview: () => void
}

const SWIPE_THRESHOLD = 60
const PINCH_THRESHOLD = 40
const IDLE_MS = 150

/** One accumulate-then-fire-once gesture axis: wheel events fire many times per physical
 *  gesture, so this locks after acting and only unlocks once its own axis goes idle. */
function makeAxis(onIdle: () => void) {
  let sum = 0
  let locked = false
  let idleTimer: number | undefined
  return {
    feed(delta: number) {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => { sum = 0; locked = false; onIdle() }, IDLE_MS)
      if (locked) return null
      sum += delta
      return sum
    },
    lock() { locked = true },
    clear() { window.clearTimeout(idleTimer) },
  }
}

/**
 * Trackpad gestures, mirroring Safari/Chrome: a two-finger horizontal swipe goes back or
 * forward, and a pinch (trackpads report this as Ctrl+wheel) opens or closes the tab
 * overview. Swipe and pinch are independent gesture axes with their own lock, so one
 * gesture finishing doesn't block the other from firing right after.
 */
export function useTrackpad(active: boolean, overviewOpen: boolean, handlers: Handlers) {
  useEffect(() => {
    if (!active) return
    const swipe = makeAxis(() => {})
    const pinch = makeAxis(() => {})
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        // A trackpad pinch arrives as a wheel event with ctrlKey set, not a "gesture" event.
        const dy = pinch.feed(e.deltaY)
        if (dy === null) return
        if (dy > PINCH_THRESHOLD && !overviewOpen) { e.preventDefault(); pinch.lock(); handlers.onToggleOverview() }
        else if (dy < -PINCH_THRESHOLD && overviewOpen) { e.preventDefault(); pinch.lock(); handlers.onToggleOverview() }
        return
      }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return // a vertical scroll, not a swipe
      const dx = swipe.feed(e.deltaX)
      if (dx === null) return
      if (dx < -SWIPE_THRESHOLD) { e.preventDefault(); swipe.lock(); handlers.onBack() }
      else if (dx > SWIPE_THRESHOLD) { e.preventDefault(); swipe.lock(); handlers.onForward() }
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('wheel', onWheel)
      swipe.clear()
      pinch.clear()
    }
  }, [active, overviewOpen, handlers])
}
