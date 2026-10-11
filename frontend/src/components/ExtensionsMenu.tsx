import { useEffect, useRef, useState } from 'react'
import { Puzzle } from './Icons'

interface Extension { id: string; name: string; openable: boolean }

/** Chromium runtime only: the app window has no extension toolbar, so installed extensions open from here. */
export function ExtensionsMenu() {
  const api = typeof window === 'undefined' ? undefined : window.haloBrowser
  const [items, setItems] = useState<Extension[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    void api?.listBrowserExtensions?.().then((list) => { if (alive) setItems(list) }).catch(() => {})
    return () => { alive = false }
  }, [api])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') setOpen(false); return }
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [open])
  if (!items.length) return null
  const launch = (item: Extension) => {
    setError(false)
    void api?.openBrowserExtension?.(item.id).then(() => setOpen(false)).catch(() => setError(true))
  }
  return (
    <div className="hx-ext" ref={root}>
      <button className="hx-icbtn" aria-label="Extensions" aria-expanded={open} aria-haspopup="menu" title="Extensions" onClick={() => setOpen((value) => !value)}><Puzzle /></button>
      {open && (
        <div className="hx-ext__menu" role="menu">
          {items.map((item) => (
            <button key={item.id} className="hx-ext__item" role="menuitem" disabled={!item.openable} onClick={() => launch(item)}>{item.name}</button>
          ))}
          {error && <p className="hx-ext__error" role="alert">Could not open the extension.</p>}
        </div>
      )}
    </div>
  )
}
