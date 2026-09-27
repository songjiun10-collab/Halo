import { useEffect, useRef } from 'react'
import { SHORTCUTS } from '../hooks/useShortcuts'

interface Props {
  leaving?: boolean
  onClose: () => void
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)
const keyLabel = (part: string) =>
  part === 'Mod' ? (isMac ? '⌘' : 'Ctrl')
    : part === 'Alt' ? (isMac ? '⌥' : 'Alt')
      : part === 'Shift' ? (isMac ? '⇧' : 'Shift')
        : part

/** The full shortcut table, opened with Shift+/ or the toolbar's own list. */
export function ShortcutsHelp({ leaving, onClose }: Props) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    if (leaving) return
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaving])

  return (
    <section className="hx-activity hx-shortcuts" data-leaving={leaving || undefined} inert={leaving} role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} ref={ref}>
      <p className="hx-activity__task">Keyboard shortcuts</p>
      <dl className="hx-shortcuts__list">
        {SHORTCUTS.map((s) => (
          <div key={s.keys}>
            <dt>{s.label}</dt>
            <dd>{s.keys.split('+').map((part, i) => <kbd key={i}>{keyLabel(part)}</kbd>)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
