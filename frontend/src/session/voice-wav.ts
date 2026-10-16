/** Recorded audio -> the 16 kHz mono 16-bit WAV that main/harness/voice-transcriber.js accepts. */
export const VOICE_RATE = 16_000
export const VOICE_MAX_SECONDS = 120

/** Joins the recorded chunks, brings them down to 16 kHz by averaging, and writes a WAV. Never longer than VOICE_MAX_SECONDS. */
export function encodeWav16k(chunks: Float32Array[], inputRate: number): ArrayBuffer {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const source = new Float32Array(total)
  let at = 0
  for (const c of chunks) { source.set(c, at); at += c.length }

  const ratio = inputRate / VOICE_RATE
  const outLength = Math.min(Math.floor(source.length / ratio), VOICE_RATE * VOICE_MAX_SECONDS)
  const pcm = new Int16Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    // Average the input samples that fall into this output sample (a cheap low-pass before dropping samples).
    const from = Math.floor(i * ratio)
    const to = Math.max(from + 1, Math.min(source.length, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = from; j < to; j += 1) sum += source[j]
    const v = Math.max(-1, Math.min(1, sum / (to - from)))
    pcm[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff)
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, VOICE_RATE, true); view.setUint32(28, VOICE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, pcm.length * 2, true)
  new Int16Array(buffer, 44).set(pcm)
  return buffer
}

/** True when the clip holds anything louder than room noise, so silence is not sent for transcription. */
export function hasSpeech(chunks: Float32Array[], threshold = 0.01): boolean {
  for (const c of chunks) for (let i = 0; i < c.length; i += 1) if (Math.abs(c[i]) > threshold) return true
  return false
}

/** Text from the box plus a new transcript, with one space between them. */
export function appendTranscript(current: string, transcript: string): string {
  const t = transcript.trim()
  if (!t) return current
  return current && !/\s$/.test(current) ? `${current} ${t}` : `${current}${t}`
}
