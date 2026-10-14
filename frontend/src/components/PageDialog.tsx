import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { PageDialogInfo } from '../session/api'

interface Props {
  dialog: PageDialogInfo
  /** true: OK / Leave. false: Cancel / Stay. A prompt's text rides with true. */
  onAnswer: (accept: boolean, text?: string) => void
}

const hostOf = (origin: string) => { try { return new URL(origin).host || origin } catch { return origin || 'This page' } }

/**
 * A dialog the page opened (alert, confirm, prompt, leave-page) on the person's own tab. The site that asks is
 * named first, from the host's reading of the tab address, so the page's words can never pose as Halo itself.
 */
export function PageDialog({ dialog, onAnswer }: Props) {
  const [text, setText] = useState(dialog.defaultPrompt)
  const first = useRef<HTMLButtonElement & HTMLInputElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const leave = dialog.type === 'beforeunload'
  const accept = () => onAnswer(true, dialog.type === 'prompt' ? text : undefined)
  const cancel = () => onAnswer(dialog.type === 'alert')
  const submit = (event: FormEvent) => { event.preventDefault(); accept() }
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }
  return (
    <form className="hx-pagedialog" role="alertdialog" aria-label={`${hostOf(dialog.origin)} says`} onSubmit={submit} onKeyDown={onKey}>
      <p className="hx-pagedialog__text">
        <strong className="hx-pagedialog__site">{hostOf(dialog.origin)}</strong>
        <span className="hx-pagedialog__says">{leave ? ' asks: leave this page? Changes you made may not be saved.' : ' says:'}</span>
        {dialog.message && !leave ? <span className="hx-pagedialog__message">{dialog.message}</span> : null}
      </p>
      {dialog.type === 'prompt' ? <input ref={first} className="hx-pagedialog__input" aria-label="Answer" maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} /> : null}
      <span className="hx-pagedialog__actions">
        {dialog.type === 'alert' ? null : <button type="button" className="hx-btn" onClick={cancel}>{leave ? 'Stay' : 'Cancel'}</button>}
        <button type="submit" className="hx-btn hx-btn--primary" ref={dialog.type === 'prompt' ? undefined : first}>{leave ? 'Leave' : 'OK'}</button>
      </span>
    </form>
  )
}
