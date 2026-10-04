import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { mergeDiscoveredNvidia, NVIDIA_MODELS, PLANNER_MODELS } = await vite.ssrLoadModule('/src/session/claude-models.ts')
after(() => vite.close())
afterEach(() => mergeDiscoveredNvidia([]))

test('discovered ids follow the built-in NVIDIA models and are replaced by the next merge', () => {
  mergeDiscoveredNvidia([{ id: 'meta/llama-4', label: 'meta/llama-4', discovered: true }])
  assert.deepEqual(PLANNER_MODELS.filter((m) => m.provider === 'nvidia').map((m) => m.id), [...NVIDIA_MODELS.map((m) => m.id), 'meta/llama-4'])
  mergeDiscoveredNvidia([])
  assert.equal(PLANNER_MODELS.some((m) => m.id === 'meta/llama-4'), false)
})

test('built-ins, undiscovered entries and malformed ids are ignored', () => {
  const before = PLANNER_MODELS.length
  mergeDiscoveredNvidia([
    { id: NVIDIA_MODELS[0].id, label: 'x', discovered: true },
    { id: 'a/b', label: 'a/b', discovered: false },
    { id: '../x', label: 'x', discovered: true },
    { id: '<img>/x', label: 'x', discovered: true },
  ])
  assert.equal(PLANNER_MODELS.length, before)
})
