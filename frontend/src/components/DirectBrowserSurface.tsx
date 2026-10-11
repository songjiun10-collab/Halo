import { memo, useEffect, useState } from 'react'
import { RemotePageFrame } from './RemotePageFrame'
import type { TaskInput } from '../session/api'

const sendInput = (input: TaskInput) => {
  void window.haloBrowser?.sendSurfaceInput?.(input).catch(() => {})
}

/** Frame updates stay below the application shell, including while the user types. */
export const DirectBrowserSurface = memo(function DirectBrowserSurface({ tabId, onCopy }: { tabId: string; onCopy?: () => void }) {
  const [frame, setFrame] = useState<string | null>(null)
  useEffect(() => {
    const api = window.haloBrowser
    if (!api?.captureSurface) return
    let stopped = false
    let timer: number | undefined
    setFrame(null)
    const tick = async () => {
      const next = await api.captureSurface!().catch(() => null)
      if (!stopped) {
        setFrame(next)
        timer = window.setTimeout(() => void tick(), 120)
      }
    }
    let unsubscribe: (() => void) | undefined
    if (typeof api.startSurfaceStream === 'function' && typeof api.onSurfaceFrame === 'function') {
      unsubscribe = api.onSurfaceFrame((payload) => {
        if (!stopped && typeof payload?.frame === 'string' && payload.frame.startsWith('data:image/jpeg;base64,')) setFrame(payload.frame)
      })
      void api.captureSurface().then((next) => {
        if (!stopped && next) setFrame((current) => current ?? next)
      }).catch(() => {})
      void api.startSurfaceStream().then((started) => {
        if (!stopped && !started) void tick()
      }).catch(() => { if (!stopped) void tick() })
    } else void tick()
    return () => { stopped = true; window.clearTimeout(timer); unsubscribe?.() }
  }, [tabId])
  // Tab changes replace the stream; leaving the surface stops it.
  useEffect(() => () => { void window.haloBrowser?.stopSurfaceStream?.().catch(() => {}) }, [])
  return frame ? <RemotePageFrame frame={frame} onInput={sendInput} onCopy={onCopy} /> : null
})
