import { useRef } from 'react'
import type { TaskInput } from '../session/api'

/** Input reaches the page only through the host's ownership check. */
export function RemotePageFrame({ frame, onInput }: { frame: string; onInput: (input: TaskInput) => void }) {
  const editor = useRef<HTMLTextAreaElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const composing = useRef(false)
  const modifiers = (event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
    [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'alt', event.metaKey && 'meta'].filter(Boolean) as string[]
  const unit = (event: { clientX: number; clientY: number }) => {
    const rect = image.current!.getBoundingClientRect()
    return { nx: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), ny: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  const button = (value: number) => value === 2 ? 'right' as const : value === 1 ? 'middle' as const : 'left' as const
  const text = (value: string) => { if (value) onInput({ type: 'insertText', text: value.slice(0, 16_384) }); if (editor.current) editor.current.value = '' }
  return <>
    <img ref={image} className="hx-snapshot" data-live="user" src={frame} alt="Interactive browser page" draggable={false}
      style={{ pointerEvents: 'auto' }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerMove={(event) => onInput({ type: 'mouseMove', ...unit(event), modifiers: modifiers(event) })}
      onPointerDown={(event) => { event.preventDefault(); editor.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); onInput({ type: 'mouseDown', ...unit(event), button: button(event.button), clickCount: Math.min(3, Math.max(1, event.detail)), modifiers: modifiers(event) }) }}
      onPointerUp={(event) => { onInput({ type: 'mouseUp', ...unit(event), button: button(event.button), modifiers: modifiers(event) }); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onWheel={(event) => onInput({ type: 'mouseWheel', ...unit(event), deltaX: -event.deltaX, deltaY: -event.deltaY, modifiers: modifiers(event) })}
    />
    <textarea ref={editor} aria-label="Browser page keyboard input" autoCapitalize="off" autoComplete="off" spellCheck={false}
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0, padding: 0, border: 0, pointerEvents: 'none' }}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={(event) => { composing.current = false; text(event.currentTarget.value) }}
      onInput={(event) => { if (!composing.current) text(event.currentTarget.value) }}
      onPaste={(event) => { event.preventDefault(); text(event.clipboardData.getData('text/plain')) }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.key === 'Process' || event.key === 'Dead') return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
        if (event.key.length > 16) return
        event.preventDefault(); event.stopPropagation(); onInput({ type: 'keyDown', key: event.key, modifiers: modifiers(event) })
      }}
      onKeyUp={(event) => { if (!composing.current && event.key.length <= 16) { event.stopPropagation(); onInput({ type: 'keyUp', key: event.key, modifiers: modifiers(event) }) } }}
    />
  </>
}
