import { useEffect } from 'react'
import type { SessionState } from '../session/types'

/** The full HALO keyboard shortcut table, in the order the help overlay lists them. */
export const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Mod+T', label: 'New tab' },
  { keys: 'Mod+W', label: 'Close tab' },
  { keys: 'Mod+1–8', label: 'Go to tab 1–8' },
  { keys: 'Mod+9', label: 'Go to the last tab' },
  { keys: 'Mod+Shift+]', label: 'Next tab' },
  { keys: 'Mod+Shift+[', label: 'Previous tab' },
  { keys: 'Alt+←', label: 'Back' },
  { keys: 'Alt+→', label: 'Forward' },
  { keys: 'Mod+L', label: 'Focus the address field' },
  { keys: 'Mod+K', label: 'New task' },
  { keys: 'Mod+Shift+L', label: 'Toggle sidebar' },
  { keys: 'Mod+.', label: 'Keep Halo unfolded' },
  { keys: 'Mod+Shift+.', label: 'Halo Chat' },
  { keys: 'Mod+Shift+A', label: 'Show all tabs' },
  { keys: 'Mod+N', label: 'New window' },
  { keys: 'Mod+Shift+S', label: 'Share' },
  { keys: 'Esc', label: 'Close the open Halo surface' },
  { keys: 'Shift+/', label: 'This list' },
]

interface Handlers {
  onNewTab: () => void
  onNewTask: () => void
  onCloseTab: (id: string) => void
  onSelectTab: (id: string) => void
  onBack: () => void
  onForward: () => void
  onFocusOmni: () => void
  onTogglePin: () => void
  onToggleChat: () => void
  onToggleOverview: () => void
  onNewWindow: () => void
  onShare: () => void
  onToggleHelp: () => void
  onToggleSidebar: () => void
}

/**
 * One global listener for every HALO shortcut. Keyed off `e.code` (the physical key), not
 * `e.key`, so Shift-combinations (Mod+Shift+.) work the same regardless of the character
 * Shift produces on the layout. Disabled almost entirely while an approval is pending —
 * the sheet is the only surface that should respond to the keyboard then, same as the
 * chrome and page being made `inert` for mouse and Tab.
 */
export function useShortcuts(s: SessionState, approval: unknown, handlers: Handlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (approval) return // A decision is the only thing the keyboard should reach.
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.code === 'Period') {
        e.preventDefault()
        if (e.shiftKey) handlers.onToggleChat()
        else handlers.onTogglePin()
        return
      }
      if (!mod && e.shiftKey && e.code === 'Slash') { e.preventDefault(); handlers.onToggleHelp(); return }
      if (e.altKey && e.code === 'ArrowLeft') { e.preventDefault(); handlers.onBack(); return }
      if (e.altKey && e.code === 'ArrowRight') { e.preventDefault(); handlers.onForward(); return }
      if (!mod) return
      if (e.code === 'KeyK' && !e.shiftKey) { e.preventDefault(); handlers.onNewTask(); return }

      const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
      if (!tab) return
      const index = s.tabs.findIndex((t) => t.id === tab.id)

      if (e.code === 'KeyT' && !e.shiftKey) { e.preventDefault(); handlers.onNewTab(); return }
      if (e.code === 'KeyW' && !e.shiftKey) { e.preventDefault(); handlers.onCloseTab(tab.id); return }
      if (e.code === 'KeyL' && !e.shiftKey) { e.preventDefault(); handlers.onFocusOmni(); return }
      if (e.code === 'KeyL' && e.shiftKey) { e.preventDefault(); handlers.onToggleSidebar(); return }
      if (e.code === 'KeyN' && !e.shiftKey) { e.preventDefault(); handlers.onNewWindow(); return }
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit && !e.shiftKey) {
        e.preventDefault()
        const to = digit[1] === '9' ? s.tabs.length - 1 : Math.min(Number(digit[1]) - 1, s.tabs.length - 1)
        handlers.onSelectTab(s.tabs[to].id)
        return
      }
      if (e.shiftKey && e.code === 'BracketRight') { e.preventDefault(); handlers.onSelectTab(s.tabs[(index + 1) % s.tabs.length].id); return }
      if (e.shiftKey && e.code === 'BracketLeft') { e.preventDefault(); handlers.onSelectTab(s.tabs[(index - 1 + s.tabs.length) % s.tabs.length].id); return }
      if (e.code === 'BracketLeft' && !e.shiftKey) { e.preventDefault(); handlers.onBack(); return }
      if (e.code === 'BracketRight' && !e.shiftKey) { e.preventDefault(); handlers.onForward(); return }
      if (e.shiftKey && e.code === 'KeyA') { e.preventDefault(); handlers.onToggleOverview(); return }
      if (e.shiftKey && e.code === 'KeyS') { e.preventDefault(); handlers.onShare(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, approval, handlers])
}
