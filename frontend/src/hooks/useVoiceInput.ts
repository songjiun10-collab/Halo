import { useCallback, useEffect, useRef, useState } from 'react'
import { appendTranscript, encodeWav16k, hasSpeech, VOICE_MAX_SECONDS } from '../session/voice-wav'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

const MESSAGES: Record<string, string> = {
  not_set_up: 'Voice input is not set up on this computer.',
  busy: 'Still turning the last clip into text.',
  timeout: 'That took too long. Try a shorter clip.',
  audio_too_long: 'That clip is too long.',
}

/**
 * Press once to record, press again to turn it into text on this computer (whisper.cpp in the main process; the audio
 * never leaves the machine). The text lands in the box for the person to read and send; nothing is sent by itself.
 */
export function useVoiceInput(onText: (transcript: string) => void) {
  const [available, setAvailable] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const session = useRef<{ stop: () => Promise<void> } | null>(null)
  const onTextRef = useRef(onText)
  useEffect(() => { onTextRef.current = onText })

  useEffect(() => {
    let live = true
    const api = window.haloBrowser
    void api?.voiceAvailable?.().then((ok) => { if (live) setAvailable(ok === true) }).catch(() => {})
    return () => { live = false; void session.current?.stop() }
  }, [])

  const start = useCallback(async () => {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      setError('The microphone is not available. Check the permission for Halo.')
      return
    }
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    let samples = 0
    let finished = false
    const finish = async () => {
      if (finished) return
      finished = true
      processor.disconnect(); source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      const rate = context.sampleRate
      void context.close()
      session.current = null
      if (!hasSpeech(chunks)) { setState('idle'); return }
      setState('transcribing')
      try {
        const wav = encodeWav16k(chunks, rate)
        const { text } = await window.haloBrowser!.transcribeAudio!(wav, { language: 'auto' })
        if (text) onTextRef.current(text)
        else setError('No words were heard.')
      } catch (e) {
        const code = (e as { code?: string; message?: string })?.code ?? ''
        setError(MESSAGES[code] ?? 'Could not turn that into text.')
      } finally { setState('idle') }
    }
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      samples += event.inputBuffer.length
      if (samples / context.sampleRate >= VOICE_MAX_SECONDS) void finish()
    }
    source.connect(processor)
    processor.connect(context.destination)
    session.current = { stop: finish }
    setState('recording')
  }, [])

  const toggle = useCallback(() => {
    if (state === 'recording') void session.current?.stop()
    else if (state === 'idle') void start()
  }, [state, start])

  return { available, state, error, toggle }
}

export { appendTranscript }
