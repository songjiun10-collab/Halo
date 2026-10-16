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
  { keys: 'Mod+R', label: 'Reload the page' },
  { keys: 'Mod+F', label: 'Find in page' },
  { keys: 'Mod+=', label: 'Zoom in' },
  { keys: 'Mod+-', label: 'Zoom out' },
  { keys: 'Mod+0', label: 'Reset zoom' },
  { keys: 'Mod+L', label: 'Focus the address field' },
  { keys: 'Mod+K', label: 'New task' },
  { keys: 'Mod+Shift+L', label: 'Toggle sidebar' },
  { keys: 'Mod+.', label: 'Keep Halo unfolded' },
  { keys: 'Mod+Shift+.', label: 'Halo Chat' },
  { keys: 'Mod+Shift+A', label: 'Show all tabs' },
  { keys: 'Mod+N', label: 'New window' },
  { keys: 'Mod+,', label: 'Settings' },
  { keys: 'Mod+Shift+S', label: 'Share' },
  { keys: 'Esc', label: 'Close the open Halo surface' },
  { keys: 'Mod+/', label: 'This list' },
]

interface Handlers {
  onNewTab: () => void
  onNewTask: () => void
  onCloseTab: (id: string) => void
  onSelectTab: (id: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onFind: () => void
  onZoom: (action: 'in' | 'out' | 'reset') => void
  onFocusOmni: () => void
  onTogglePin: () => void
  onToggleChat: () => void
  onToggleOverview: () => void
  onNewWindow: () => void
  onShare: () => void
  onToggleHelp: () => void
  onToggleSidebar: () => void
  onToggleSettings: () => void
}

type KeyPress = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { target?: EventTarget | null }

export type ShortcutAction =
  | 'toggleChat' | 'togglePin' | 'help' | 'reload' | 'back' | 'forward' | 'newTask' | 'settings'
  | 'newTab' | 'closeTab' | 'find' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'focusOmni' | 'toggleSidebar'
  | 'newWindow' | 'selectTab' | 'nextTab' | 'previousTab' | 'overview' | 'share'

/** `needsTab`: does nothing (and leaves the key alone) while there is no tab. `position`: Mod+1–9, 9 is the last tab. */
export interface Shortcut { action: ShortcutAction; needsTab: boolean; position?: number }

/**
 * Which HALO shortcut a key press is, or null. Keyed off `e.code` (the physical key), not
 * `e.key`, so Shift-combinations (Mod+Shift+.) work the same regardless of the character
 * Shift produces on the layout.
 */
export function shortcutFor(e: KeyPress): Shortcut | null {
  const mod = e.metaKey || e.ctrlKey
  const anywhere = (action: ShortcutAction): Shortcut => ({ action, needsTab: false })
  const onTab = (action: ShortcutAction): Shortcut => ({ action, needsTab: true })
  if (mod && e.code === 'Period') return anywhere(e.shiftKey ? 'toggleChat' : 'togglePin')
  if (mod && !e.shiftKey && !e.altKey && e.code === 'Slash') return anywhere('help')
  if (!mod && !e.shiftKey && !e.altKey && e.code === 'F5') return anywhere('reload')
  if (e.altKey && e.code === 'ArrowLeft') return anywhere('back')
  if (e.altKey && e.code === 'ArrowRight') return anywhere('forward')
  if (!mod) return null
  if (e.code === 'KeyK' && !e.shiftKey) return anywhere('newTask')
  if (e.code === 'Comma' && !e.shiftKey) return anywhere('settings')
  if (e.code === 'KeyT' && !e.shiftKey) return onTab('newTab')
  if (e.code === 'KeyW' && !e.shiftKey) return onTab('closeTab')
  if (e.code === 'KeyR') return onTab('reload')
  if (e.code === 'KeyF' && !e.shiftKey) return onTab('find')
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && !e.altKey) return onTab('zoomIn')
  if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && !e.altKey) return onTab('zoomOut')
  if ((e.code === 'Digit0' || e.code === 'Numpad0') && !e.shiftKey) return onTab('zoomReset')
  if (e.code === 'KeyL') return onTab(e.shiftKey ? 'toggleSidebar' : 'focusOmni')
  if (e.code === 'KeyN' && !e.shiftKey) return onTab('newWindow')
  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit && !e.shiftKey) return { ...onTab('selectTab'), position: Number(digit[1]) }
  if (e.code === 'BracketRight') return onTab(e.shiftKey ? 'nextTab' : 'forward')
  if (e.code === 'BracketLeft') return onTab(e.shiftKey ? 'previousTab' : 'back')
  if (e.shiftKey && e.code === 'KeyA') return onTab('overview')
  if (e.shiftKey && e.code === 'KeyS') return onTab('share')
  return null
}

/**
 * A key pressed while the person's page has the keyboard. Like a browser, HALO keeps its
 * Ctrl/Cmd shortcuts and F5; everything else, Alt+arrow included (it moves by word in a Mac
 * text field), goes to the page.
 */
export function leaveToHalo(e: KeyPress): boolean {
  return (e.metaKey || e.ctrlKey || e.code === 'F5') && shortcutFor(e) !== null
}

/**
 * One global listener for every HALO shortcut. Disabled almost entirely while an approval
 * is pending — the sheet is the only surface that should respond to the keyboard then,
 * same as the chrome and page being made `inert` for mouse and Tab.
 */
export function useShortcuts(s: SessionState, approval: unknown, handlers: Handlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (approval) return // A decision is the only thing the keyboard should reach.
      const shortcut = shortcutFor(e)
      if (!shortcut) return
      const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
      if (shortcut.needsTab && !tab) return
      e.preventDefault()
      const index = tab ? s.tabs.findIndex((t) => t.id === tab.id) : -1
      switch (shortcut.action) {
        case 'toggleChat': handlers.onToggleChat(); return
        case 'togglePin': handlers.onTogglePin(); return
        case 'help': handlers.onToggleHelp(); return
        case 'reload': handlers.onReload(); return
        case 'back': handlers.onBack(); return
        case 'forward': handlers.onForward(); return
        case 'newTask': handlers.onNewTask(); return
        case 'settings': handlers.onToggleSettings(); return
        case 'newTab': handlers.onNewTab(); return
        case 'closeTab': if (tab) handlers.onCloseTab(tab.id); return
        case 'find': handlers.onFind(); return
        case 'zoomIn': handlers.onZoom('in'); return
        case 'zoomOut': handlers.onZoom('out'); return
        case 'zoomReset': handlers.onZoom('reset'); return
        case 'focusOmni': handlers.onFocusOmni(); return
        case 'toggleSidebar': handlers.onToggleSidebar(); return
        case 'newWindow': handlers.onNewWindow(); return
        case 'selectTab': {
          const position = shortcut.position ?? 1
          handlers.onSelectTab(s.tabs[position === 9 ? s.tabs.length - 1 : Math.min(position - 1, s.tabs.length - 1)].id)
          return
        }
        case 'nextTab': handlers.onSelectTab(s.tabs[(index + 1) % s.tabs.length].id); return
        case 'previousTab': handlers.onSelectTab(s.tabs[(index - 1 + s.tabs.length) % s.tabs.length].id); return
        case 'overview': handlers.onToggleOverview(); return
        case 'share': handlers.onShare(); return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, approval, handlers])
}
