import { useEffect, useRef, useState } from 'react'

interface FindResult { ok: boolean; found: boolean; matches?: number; active?: number; errorCode?: string }

interface Props {
  /** null searches the user's own active tab; a taskId searches a taken-over task page. */
  targetTaskId: string | null
  onClose: () => void
}

/**
 * Chrome-style find bar for the page slot. Mod+F opens it, Esc closes it,
 * Enter / Shift+Enter walk matches. Every search is host-side and read-only
 * (window.find on Chromium, findInPage on Electron); the bar only renders the
 * truth the host returns, and stale responses are dropped by sequence number.
 */
export function FindBar({ targetTaskId, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FindResult | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const debounce = useRef<number | undefined>(undefined)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => window.clearTimeout(debounce.current), [])

  const search = (text: string, forward: boolean) => {
    window.clearTimeout(debounce.current)
    const api = window.haloBrowser
    const id = ++seq.current
    if (!text.trim() || typeof api?.findInPage !== 'function') {
      setResult(null)
      setPending(false)
      return
    }
    setPending(true)
    void api.findInPage(targetTaskId, text, { forward })
      .then((next) => { if (seq.current === id) { setResult(next); setPending(false) } })
      .catch(() => { if (seq.current === id) { setResult({ ok: false, found: false, errorCode: 'find_failed' }); setPending(false) } })
  }

  const onChange = (value: string) => {
    setQuery(value)
    // One search per typing pause; Enter/arrows search immediately.
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => search(value, true), 120)
  }

  const status = pending
    ? 'Searching…'
    : !query.trim()
      ? ''
      : result === null
        ? ''
        : !result.ok
          ? 'Not available here'
          : result.found
            ? result.matches !== undefined
              ? `${result.active ?? '?'}/${result.matches}`
              : 'Found'
            : 'No results'

  return (
    <div className="hx-find" role="search" aria-label="Find on page" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}>
      <input
        ref={inputRef}
        className="hx-find__input"
        value={query}
        placeholder="Find on page"
        aria-label="Find on page"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); search(query, !event.shiftKey) }
          else if (event.key === 'Escape') { event.preventDefault(); onClose() }
        }}
      />
      <span className="hx-find__status" aria-live="polite">{status}</span>
      <button type="button" className="hx-icbtn" aria-label="Previous match" title="Previous match (⇧⏎)" onClick={() => search(query, false)}>↑</button>
      <button type="button" className="hx-icbtn" aria-label="Next match" title="Next match (⏎)" onClick={() => search(query, true)}>↓</button>
      <button type="button" className="hx-icbtn" aria-label="Close find" title="Close (Esc)" onClick={onClose}>×</button>
    </div>
  )
}
