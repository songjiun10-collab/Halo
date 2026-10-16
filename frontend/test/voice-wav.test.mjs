import assert from 'node:assert/strict'
import test from 'node:test'
import { appendTranscript, encodeWav16k, hasSpeech, VOICE_MAX_SECONDS, VOICE_RATE } from '../src/session/voice-wav.ts'

const ascii = (buf, from, to) => String.fromCharCode(...new Uint8Array(buf, from, to - from))

test('48 kHz audio becomes a 16 kHz mono 16-bit WAV of one third the samples', () => {
  const input = new Float32Array(4800).fill(0.5)
  const wav = encodeWav16k([input.subarray(0, 2000), input.subarray(2000)], 48000)
  const view = new DataView(wav)
  assert.equal(ascii(wav, 0, 4), 'RIFF'); assert.equal(ascii(wav, 8, 12), 'WAVE'); assert.equal(ascii(wav, 12, 16), 'fmt ')
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), VOICE_RATE); assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 1600 * 2)
  assert.equal(wav.byteLength, 44 + 3200)
  assert.equal(new Int16Array(wav, 44)[0], Math.round(0.5 * 0x7fff))
})

test('samples are clamped, and the clip never exceeds the length the host accepts', () => {
  const loud = encodeWav16k([new Float32Array([2, -2, 0.1, 0.1])], 16000)
  const pcm = new Int16Array(loud, 44)
  assert.equal(pcm[0], 0x7fff); assert.equal(pcm[1], -0x8000)
  const long = encodeWav16k([new Float32Array(16000 * (VOICE_MAX_SECONDS + 30))], 16000)
  assert.equal(long.byteLength, 44 + VOICE_RATE * VOICE_MAX_SECONDS * 2)
  assert.equal(encodeWav16k([], 48000).byteLength, 44)
})

test('hasSpeech ignores room noise, and transcripts join the box text with one space', () => {
  assert.equal(hasSpeech([new Float32Array(100).fill(0.001)]), false)
  assert.equal(hasSpeech([new Float32Array([0, 0, 0.2])]), true)
  assert.equal(appendTranscript('', ' 안녕 '), '안녕')
  assert.equal(appendTranscript('주문해', '지금'), '주문해 지금')
  assert.equal(appendTranscript('주문해 ', '지금'), '주문해 지금')
  assert.equal(appendTranscript('abc', '  '), 'abc')
})
