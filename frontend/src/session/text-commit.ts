// Turns textarea input and IME composition events into the text the page should receive.
// The old handler sent the textarea's whole value on compositionend and cleared it, so a
// Korean IME that commits one syllable while starting the next ("한" then "ㄱ") sent the
// half-formed jamo too, or dropped it when the box was cleared mid-composition.
// This commits only what the IME reports as committed and never clears during a composition.

export const COMMIT_ECHO_MS = 60

export type TextCommitter = {
  compositionStart(): void
  /** The committed string the IME reports (`event.data`). */
  compositionEnd(data: string): void
  /** A plain input event. Ignored while composing. */
  input(event: { data?: string | null; isComposing?: boolean; value: string }): void
  /** A paste: always plain text. */
  paste(text: string): void
  /** True while an IME composition is in progress, so the box must not be cleared. */
  readonly composing: boolean
}

export function createTextCommitter(send: (text: string) => void, now: () => number = () => Date.now()): TextCommitter {
  let composing = false
  let lastCommit = ''
  let lastAt = -Infinity
  return {
    get composing() { return composing },
    compositionStart() { composing = true },
    compositionEnd(data) {
      composing = false
      if (!data) return
      send(data)
      lastCommit = data
      lastAt = now()
    },
    input({ data, isComposing, value }) {
      if (composing || isComposing) return
      const text = data ?? value
      if (!text) return
      // Some engines fire a plain input carrying the same text right after compositionend.
      if (text === lastCommit && now() - lastAt < COMMIT_ECHO_MS) { lastCommit = ''; return }
      send(text)
    },
    paste(text) { if (text) send(text) },
  }
}
