"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { VoiceTranscriber, checkWav, cleanText } = require("../main/harness/voice-transcriber");

function wav({ rate = 16000, channels = 1, bits = 16, samples = 1600 } = {}) {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
async function setup(t, { withModel = true } = {}) {
  const voiceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "halo-voice-test-"));
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "halo-voice-tmp-"));
  await fsp.writeFile(path.join(voiceDir, "whisper-cli"), "#!/bin/sh\n");
  if (withModel) await fsp.writeFile(path.join(voiceDir, "ggml-base.bin"), "x");
  t.after(() => Promise.all([fsp.rm(voiceDir, { recursive: true, force: true }), fsp.rm(tmpRoot, { recursive: true, force: true })]));
  return { voiceDir, tmpRoot };
}

test("checkWav accepts the window's format and refuses anything else", () => {
  checkWav(wav());
  for (const bad of [wav({ rate: 44100 }), wav({ channels: 2 }), wav({ bits: 8 }), Buffer.from("hello"), Buffer.alloc(10)]) assert.throws(() => checkWav(bad), { code: "bad_audio" });
  assert.throws(() => checkWav(wav({ samples: 16000 * 121 })), { code: "audio_too_long" });
});

test("cleanText drops silence and noise markers", () => {
  assert.equal(cleanText(" [BLANK_AUDIO] \n"), "");
  assert.equal(cleanText("  주문 해줘 (music) ♪ 지금\n"), "주문 해줘 지금");
});

test("transcribe runs the local program with fixed arguments, returns text and deletes the clip", async (t) => {
  const { voiceDir, tmpRoot } = await setup(t);
  let seen;
  const run = (bin, args, opts, cb) => { seen = { bin, args, existed: fs.existsSync(args[args.indexOf("-f") + 1]), opts }; cb(null, " 안녕하세요 \n"); };
  const voice = new VoiceTranscriber({ voiceDir, tmpRoot, run });
  assert.equal(voice.available(), true);
  assert.deepEqual(await voice.transcribe(wav(), { language: "ko" }), { text: "안녕하세요" });
  assert.equal(seen.bin, path.join(voiceDir, "whisper-cli"));
  assert.deepEqual(seen.args.filter((a) => !a.includes(tmpRoot)), ["-m", path.join(voiceDir, "ggml-base.bin"), "-f", "-l", "ko", "-nt", "-np"]);
  assert.equal(seen.existed, true, "the clip existed while whisper ran");
  assert.deepEqual(await fsp.readdir(tmpRoot), [], "the clip is gone afterwards");
});

test("temp files are removed when whisper fails, and a failure message does not leak program output", async (t) => {
  const { voiceDir, tmpRoot } = await setup(t);
  const voice = new VoiceTranscriber({ voiceDir, tmpRoot, run: (b, a, o, cb) => cb(Object.assign(new Error("SECRET path /x"), { code: 1 })) });
  await assert.rejects(() => voice.transcribe(wav()), (e) => e.code === "failed" && !/SECRET/.test(e.message));
  assert.deepEqual(await fsp.readdir(tmpRoot), []);
  const slow = new VoiceTranscriber({ voiceDir, tmpRoot, run: (b, a, o, cb) => cb(Object.assign(new Error("t"), { killed: true })) });
  await assert.rejects(() => slow.transcribe(wav()), { code: "timeout" });
});

test("without the program or a model it reports not set up; bad input never reaches whisper; one clip at a time", async (t) => {
  const none = await setup(t, { withModel: false });
  const v1 = new VoiceTranscriber({ voiceDir: none.voiceDir, tmpRoot: none.tmpRoot, run: () => assert.fail("must not run") });
  assert.equal(v1.available(), false);
  await assert.rejects(() => v1.transcribe(wav()), { code: "not_set_up" });

  const ok = await setup(t);
  let release;
  const v2 = new VoiceTranscriber({ voiceDir: ok.voiceDir, tmpRoot: ok.tmpRoot, run: (b, a, o, cb) => { release = () => cb(null, "hi"); } });
  await assert.rejects(() => v2.transcribe(Buffer.from("nope")), { code: "bad_audio" });
  await assert.rejects(() => v2.transcribe(wav(), { language: "ko; rm -rf /" }), { code: "bad_language" });
  const first = v2.transcribe(wav());
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() => v2.transcribe(wav()), { code: "busy" });
  release();
  assert.deepEqual(await first, { text: "hi" });
});
