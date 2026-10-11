import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { createTextCommitter } = await vite.ssrLoadModule('/src/session/text-commit.ts')
test.after(() => vite.close())

function setup() {
  const sent = []
  let t = 1000
  const committer = createTextCommitter((text) => sent.push(text), () => t)
  return { sent, committer, tick: (ms) => { t += ms } }
}

test('plain typing sends the typed character, not the whole box', () => {
  const { sent, committer } = setup()
  committer.input({ data: 'a', isComposing: false, value: 'a' })
  committer.input({ data: 'b', isComposing: false, value: 'ab' })
  assert.deepEqual(sent, ['a', 'b'])
})

test('a Korean syllable is sent once, from the IME commit, never the half-formed next jamo', () => {
  const { sent, committer } = setup()
  committer.compositionStart()
  committer.input({ data: 'ㅎ', isComposing: true, value: 'ㅎ' })
  committer.input({ data: '한', isComposing: true, value: '한' })
  // The IME commits "한" and starts "ㄱ" in the same tick; the box already shows both.
  committer.compositionEnd('한')
  committer.compositionStart()
  committer.input({ data: 'ㄱ', isComposing: true, value: '한ㄱ' })
  committer.input({ data: '글', isComposing: true, value: '한글' })
  committer.compositionEnd('글')
  assert.deepEqual(sent, ['한', '글'])
})

test('an echo input right after compositionend does not double the commit', () => {
  const { sent, committer, tick } = setup()
  committer.compositionStart()
  committer.compositionEnd('한')
  tick(5)
  committer.input({ data: '한', isComposing: false, value: '한' })
  assert.deepEqual(sent, ['한'])
  tick(500)
  committer.input({ data: '한', isComposing: false, value: '한' })
  assert.deepEqual(sent, ['한', '한'], 'the same letter typed later is real input')
})

test('input during a composition is ignored and a paste goes through whole', () => {
  const { sent, committer } = setup()
  committer.compositionStart()
  committer.input({ data: 'ㅎ', isComposing: false, value: 'ㅎ' })
  assert.deepEqual(sent, [])
  committer.compositionEnd('')
  committer.paste('hello 한글')
  assert.deepEqual(sent, ['hello 한글'])
})
