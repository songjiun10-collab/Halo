import { useMemo, useRef } from 'react'
import { createTextCommitter } from '../session/text-commit'
import type { TaskInput } from '../session/api'

/** Input reaches the page only through the host's ownership check. */
export function RemotePageFrame({ frame, onInput, onCopy }: { frame: string; onInput: (input: TaskInput) => void; onCopy?: () => void }) {
  const editor = useRef<HTMLTextAreaElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const modifiers = (event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
    [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'alt', event.metaKey && 'meta'].filter(Boolean) as string[]
  const unit = (event: { clientX: number; clientY: number }) => {
    const rect = image.current!.getBoundingClientRect()
    return { nx: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), ny: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  const button = (value: number) => value === 2 ? 'right' as const : value === 1 ? 'middle' as const : 'left' as const
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput
  const committer = useMemo(() => createTextCommitter((value) => onInputRef.current({ type: 'insertText', text: value.slice(0, 16_384) })), [])
  // Cleared only when no composition is running; a next syllable may start right after the last ends.
  const clear = () => { if (editor.current && !committer.composing) editor.current.value = '' }
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
      onCompositionStart={() => committer.compositionStart()}
      onCompositionEnd={(event) => { committer.compositionEnd(event.data); setTimeout(clear, 0) }}
      onInput={(event) => { committer.input({ data: (event.nativeEvent as InputEvent).data, isComposing: (event.nativeEvent as InputEvent).isComposing, value: event.currentTarget.value }); clear() }}
      onPaste={(event) => { event.preventDefault(); committer.paste(event.clipboardData.getData('text/plain')); clear() }}
      onKeyDown={(event) => {
        if (committer.composing || event.nativeEvent.isComposing || event.key === 'Process' || event.key === 'Dead') return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
        // Mod+C copies the page's own selection through the host clipboard
        // path; the page's synthesized copy command is not reliable over CDP.
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
          if (onCopy) { event.preventDefault(); event.stopPropagation(); onCopy() }
          return
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
        if (event.key.length > 16) return
        event.preventDefault(); event.stopPropagation(); onInput({ type: 'keyDown', key: event.key, modifiers: modifiers(event) })
      }}
      onKeyUp={(event) => { if (!committer.composing && !event.nativeEvent.isComposing && event.key.length <= 16) { event.stopPropagation(); onInput({ type: 'keyUp', key: event.key, modifiers: modifiers(event) }) } }}
    />
  </>
}
