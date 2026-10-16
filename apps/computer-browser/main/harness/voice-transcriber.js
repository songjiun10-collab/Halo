"use strict";

// Speech to text on this computer with whisper.cpp. The window records a short clip, sends it here as
// a 16 kHz mono 16-bit WAV, and gets the text back to put in the chat box (a person reads and sends
// it). Audio never leaves the machine: it is written to a private temp folder, handed to the local
// whisper-cli program, and deleted when the run ends, success or not. Nothing is kept, journaled or
// sent to a planner as audio; the text goes through the same rules as anything typed.
//
// Where the program and model live (none ships with the app; a missing one reports "not set up"):
//   HALO_WHISPER_BIN    path to whisper-cli          (else <voiceDir>/whisper-cli)
//   HALO_WHISPER_MODEL  path to a ggml-*.bin model   (else the first ggml-*.bin in <voiceDir>)

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 120;
const MAX_BYTES = 44 + MAX_SECONDS * SAMPLE_RATE * 2;
const TIMEOUT_MS = 120_000;

class VoiceError extends Error {
  constructor(code, message) { super(message); this.name = "VoiceError"; this.code = code; }
}

// Accepts exactly what the window sends: RIFF/WAVE, PCM, mono, 16 kHz, 16-bit. Anything else is refused
// before it reaches a program that parses audio.
function checkWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new VoiceError("bad_audio", "audio is too short or not a buffer");
  if (buffer.length > MAX_BYTES) throw new VoiceError("audio_too_long", `audio is longer than ${MAX_SECONDS} seconds`);
  const ok = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE" && buffer.toString("ascii", 12, 16) === "fmt "
    && buffer.readUInt16LE(20) === 1 && buffer.readUInt16LE(22) === 1 && buffer.readUInt32LE(24) === SAMPLE_RATE && buffer.readUInt16LE(34) === 16;
  if (!ok) throw new VoiceError("bad_audio", "audio must be 16 kHz mono 16-bit WAV");
}

// whisper prints markers for silence and noise; they are not words.
function cleanText(raw) {
  return String(raw)
    .replace(/\[[A-Z_ ]+\]|\([a-z ]+\)|♪+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function locate({ voiceDir, env = process.env, exists = fs.existsSync, list = (d) => fs.readdirSync(d) }) {
  let bin = env.HALO_WHISPER_BIN || path.join(voiceDir, "whisper-cli");
  let model = env.HALO_WHISPER_MODEL || null;
  if (!model) {
    try { const found = list(voiceDir).filter((n) => /^ggml-.*\.bin$/.test(n)).sort()[0]; if (found) model = path.join(voiceDir, found); } catch { /* no folder yet */ }
  }
  if (!exists(bin) || !model || !exists(model)) return null;
  return { bin, model };
}

class VoiceTranscriber {
  constructor({ voiceDir, env, run = execFile, tmpRoot = os.tmpdir(), timeoutMs = TIMEOUT_MS } = {}) {
    if (typeof voiceDir !== "string" || !voiceDir) throw new VoiceError("invalid_config", "voiceDir is required");
    Object.assign(this, { _voiceDir: voiceDir, _env: env, _run: run, _tmpRoot: tmpRoot, _timeoutMs: timeoutMs });
    this._busy = false;
  }

  // Cheap check for the window: should the mic button be shown at all?
  available() { return locate({ voiceDir: this._voiceDir, env: this._env }) !== null; }

  async transcribe(buffer, { language = "auto" } = {}) {
    const found = locate({ voiceDir: this._voiceDir, env: this._env });
    if (!found) throw new VoiceError("not_set_up", "voice input is not set up: put whisper-cli and a ggml model in the voice folder");
    checkWav(buffer);
    if (this._busy) throw new VoiceError("busy", "a clip is already being transcribed");
    if (!/^[a-z]{2,3}$|^auto$/.test(language)) throw new VoiceError("bad_language", "language must be auto or a short code like ko");
    this._busy = true;
    const dir = await fsp.mkdtemp(path.join(this._tmpRoot, "halo-voice-"));
    try {
      await fsp.chmod(dir, 0o700);
      const file = path.join(dir, "clip.wav");
      await fsp.writeFile(file, buffer, { mode: 0o600 });
      // No shell: the arguments are a fixed list, and the file name is ours.
      const stdout = await new Promise((resolve, reject) => {
        this._run(found.bin, ["-m", found.model, "-f", file, "-l", language, "-nt", "-np"], { timeout: this._timeoutMs, maxBuffer: 1_000_000, windowsHide: true }, (error, out) => {
          if (error) reject(error.killed || error.signal ? new VoiceError("timeout", "transcription took too long") : new VoiceError("failed", "whisper could not read this clip"));
          else resolve(out);
        });
      });
      return { text: cleanText(stdout) };
    } finally {
      this._busy = false;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { VoiceTranscriber, VoiceError, checkWav, cleanText, locate, SAMPLE_RATE, MAX_SECONDS };
