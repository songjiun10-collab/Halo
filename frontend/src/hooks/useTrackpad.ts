import { useEffect } from 'react'

interface Handlers {
  onBack: () => void
  onForward: () => void
  onToggleOverview: () => void
}

const SWIPE_THRESHOLD = 60
const PINCH_THRESHOLD = 40
const GESTURE_SCALE_CLOSE = 0.7 // pinched together this far -> open the overview
const GESTURE_SCALE_OPEN = 1.3  // spread apart this far -> close it
const IDLE_MS = 150

/** Safari's own pinch API (WebKit-only): fires on real trackpad pinch, unlike the
 *  Ctrl+wheel translation Chrome and Firefox synthesize instead. Not in the DOM lib. */
interface GestureEvent extends Event {
  scale: number
  preventDefault(): void
}
const supportsGesture = typeof window !== 'undefined' && 'ongesturestart' in window

/** One accumulate-then-fire-once gesture axis: wheel events fire many times per physical
 *  gesture, so this locks after acting and only unlocks once its own axis goes idle. */
function makeAxis() {
  let sum = 0
  let locked = false
  let idleTimer: number | undefined
  return {
    feed(delta: number) {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => { sum = 0; locked = false }, IDLE_MS)
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
 * forward, and a pinch opens or closes the tab overview.
 *
 * Pinch detection is engine-specific: Safari (WebKit) fires its own `gesturestart` /
 * `gesturechange` / `gestureend` on a real trackpad pinch, which is what this uses on
 * macOS Safari; Chrome and Firefox never fire those, so there we fall back to the
 * Ctrl+wheel translation they synthesize instead. Only one path runs per engine.
 */
export function useTrackpad(active: boolean, overviewOpen: boolean, handlers: Handlers) {
  useEffect(() => {
    if (!active) return
    const swipe = makeAxis()
    const pinch = makeAxis()

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        if (supportsGesture) return // Safari: handled by the native gesture events below.
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
    const cleanups = [() => window.removeEventListener('wheel', onWheel), swipe.clear, pinch.clear]

    if (supportsGesture) {
      let fired = false
      const onStart = (e: Event) => { (e as GestureEvent).preventDefault(); fired = false }
      const onChange = (e: Event) => {
        const scale = (e as GestureEvent).scale
        ;(e as GestureEvent).preventDefault()
        if (fired) return
        if (scale < GESTURE_SCALE_CLOSE && !overviewOpen) { fired = true; handlers.onToggleOverview() }
        else if (scale > GESTURE_SCALE_OPEN && overviewOpen) { fired = true; handlers.onToggleOverview() }
      }
      const onEnd = (e: Event) => { (e as GestureEvent).preventDefault() }
      window.addEventListener('gesturestart', onStart)
      window.addEventListener('gesturechange', onChange)
      window.addEventListener('gestureend', onEnd)
      cleanups.push(
        () => window.removeEventListener('gesturestart', onStart),
        () => window.removeEventListener('gesturechange', onChange),
        () => window.removeEventListener('gestureend', onEnd),
      )
    }

    return () => cleanups.forEach((fn) => fn())
  }, [active, overviewOpen, handlers])
}
