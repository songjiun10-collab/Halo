import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Close } from './Icons'

interface Props {
  /** Search the page in view; resolves with whether it matched and how many matches there are. */
  onFind: (query: string, backwards: boolean) => Promise<{ found: boolean; count: number }>
  onClose: () => void
}

/** Find in page: Enter steps forward, Shift+Enter backward, Escape closes and clears the selection. */
export function FindBar({ onFind, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ found: boolean; count: number } | null>(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  const run = async (backwards: boolean) => {
    const text = query.trim()
    if (!text) { setResult(null); return }
    setResult(await onFind(text, backwards))
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void run(false) }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); void run(true) }
  }
  return (
    <form className="hx-find" role="search" aria-label="Find in page" onSubmit={submit} onKeyDown={onKey}>
      <input ref={inputRef} className="hx-find__input" aria-label="Find in page" placeholder="Find in page" maxLength={200} value={query} spellCheck={false} onChange={(event) => { setQuery(event.target.value); setResult(null) }} />
      <span className="hx-find__count" role="status" aria-live="polite">{result ? (result.found ? (result.count > 0 ? `${result.count} on page` : 'Found') : 'No matches') : ''}</span>
      <button type="button" className="hx-icbtn hx-icbtn--sm" aria-label="Previous match" title="Previous (Shift+Enter)" onClick={() => void run(true)}><span aria-hidden="true">↑</span></button>
      <button type="submit" className="hx-icbtn hx-icbtn--sm" aria-label="Next match" title="Next (Enter)"><span aria-hidden="true">↓</span></button>
      <button type="button" className="hx-icbtn hx-icbtn--sm" aria-label="Close find" title="Close (Escape)" onClick={onClose}><Close /></button>
    </form>
  )
}
