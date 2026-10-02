import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { ModelPicker } = await vite.ssrLoadModule('/src/components/ModelPicker.tsx')
const { CLAUDE_MODELS, CODEX_MODELS, DEFAULT_CLAUDE_MODEL, saveModel } = await vite.ssrLoadModule('/src/session/claude-models.ts')
const host = createRequire(import.meta.url)('../../apps/computer-browser/main/harness/providers/claude-models.js')
const codexHost = createRequire(import.meta.url)('../../apps/computer-browser/main/harness/providers/codex-models.js')
test.after(() => vite.close())

const settings = { version: 5, executionMode: 'sequential', permissionMode: 'browse', plannerEffort: 'medium', memoryPolicy: 'budgeted', plannerProvider: 'claude_code' }

test('the picker lists exactly the host model allowlist', () => {
  assert.deepEqual(CLAUDE_MODELS.map(({ id, label, family, legacy }) => ({ id, label, family, legacy })), host.CLAUDE_MODELS.map((m) => ({ ...m })))
  assert.equal(DEFAULT_CLAUDE_MODEL, host.DEFAULT_CLAUDE_MODEL)
})

test('versioned Opus, Sonnet and Haiku are listed, with legacy models in their own group', () => {
  const html = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerModel: 'claude-sonnet-4-5-20250929' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true, defaultView: 'models' }))
  assert.match(html, /<span>Claude Sonnet 4.5<\/span>/, 'the toggle names the pinned model and version')
  for (const label of ['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'Opus 4.5', 'Opus 4.1', 'Opus 4', 'Sonnet 4', 'Sonnet 3.7', 'Haiku 3.5']) {
    assert.match(html, new RegExp(`<span>${label.replace('.', '\\.')}</span>`), label)
  }
  assert.match(html, /Opus 5\.5[\s\S]*class="hx-mpick__fold" aria-expanded="true"[^>]*>Legacy[\s\S]*Opus 4\.5/)
  assert.match(html, /role="radio" aria-checked="true"[^>]*>(?:(?!<\/button>).)*Sonnet 4\.5/)
  assert.equal(html.match(/aria-checked="true"/g).length, 1)
})

test('without a planner the toggle asks for a model and nothing is checked', () => {
  const html = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerProvider: 'none' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true, defaultView: 'models' }))
  assert.match(html, /<span>Model<\/span>/)
  assert.doesNotMatch(html, /aria-checked="true"/)
})

test('saving a model turns on the Claude planner and pins only an allowlisted id', async () => {
  const calls = []
  const api = { updateHostSettings: async (patch) => { calls.push(patch); return { ...settings, ...patch } } }
  assert.equal((await saveModel(api, 'claude-haiku-4-5-20251001')).plannerModel, 'claude-haiku-4-5-20251001')
  assert.deepEqual(calls, [{ plannerProvider: 'claude_code', plannerModel: 'claude-haiku-4-5-20251001' }])
  assert.equal(await saveModel(api, 'opus'), null)
  assert.equal(calls.length, 1)
  assert.equal(await saveModel({ updateHostSettings: async () => { throw new Error('no') } }, 'claude-opus-5-5'), null)
})

test('Codex models mirror the host Codex allowlist and are listed in their own group', () => {
  assert.deepEqual(CODEX_MODELS.map(({ id, label, legacy }) => ({ id, label, legacy })), codexHost.CODEX_MODELS.map(({ id, label, legacy }) => ({ id, label, legacy })))
  const html = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerProvider: 'codex_cli', plannerModel: 'gpt-5.6-sol' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true, defaultView: 'models' }))
  assert.match(html, /<span>Codex GPT-5\.6 Sol<\/span>/)
  assert.match(html, /<p>Model<\/p>[\s\S]*Opus 5\.5[\s\S]*<p>Codex<\/p>[\s\S]*GPT-6\.1 Sol[\s\S]*GPT-6 Astra[\s\S]*GPT-6 Sol[\s\S]*GPT-6 Luna[\s\S]*GPT-5\.6 Sol[\s\S]*GPT-5\.6 Terra[\s\S]*GPT-5\.6 Luna[\s\S]*GPT-5\.5<\/span>[\s\S]*>Legacy/)
  assert.match(html, /model-icons\/codex\.png/)
  assert.match(html, /role="radio" aria-checked="true"[^>]*>(?:(?!<\/button>).)*GPT-5\.6 Sol/)
  assert.equal(html.match(/aria-checked="true"/g).length, 1)
})

test('saving a Codex model switches the planner provider to codex_cli', async () => {
  const calls = []
  const api = { updateHostSettings: async (patch) => { calls.push(patch); return { ...settings, ...patch } } }
  await saveModel(api, 'gpt-5.5')
  await saveModel(api, 'claude-opus-5-5')
  assert.deepEqual(calls, [{ plannerProvider: 'codex_cli', plannerModel: 'gpt-5.5' }, { plannerProvider: 'claude_code', plannerModel: 'claude-opus-5-5' }])
})

test('legacy models stay folded unless the pinned model is one of them', () => {
  const html = renderToStaticMarkup(React.createElement(ModelPicker, { settings, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true, defaultView: 'models' }))
  assert.match(html, /<button type="button" class="hx-mpick__fold" aria-expanded="false"[^>]*>Legacy/)
  for (const label of ['Opus 4\\.5', 'Sonnet 3\\.7']) assert.doesNotMatch(html, new RegExp(label), label)
  // Every Codex model stays visible in the Codex group; only Claude legacy folds.
  assert.match(html, /<p>Codex<\/p>(?:[\s\S]*?model-icons\/codex\.png){8}[\s\S]*>Legacy/)
})

test('like the Codex app, the popover opens on effort: label, model name with a chevron, dotted slider, reset', () => {
  const html = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerProvider: 'codex_cli', plannerEffort: 'low' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true }))
  assert.match(html, /<div class="hx-mpick__pop" data-view="effort">/)
  assert.match(html, /class="hx-mpick__card" data-level="low"[\s\S]*<b>Light<\/b>[\s\S]*class="hx-mpick__model"[^>]*>GPT-6\.1 Sol<svg/)
  assert.match(html, /class="hx-mpick__reset" aria-label="Reset effort"/)
  assert.match(html, /<div class="hx-effort" data-level="low">[\s\S]*type="range"/)
  assert.doesNotMatch(html, /<p>Codex<\/p>/, 'the model list waits behind the chevron')
  assert.equal(html.match(/class="hx-effort__dot"/g).length, 6)
  const ultra = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerProvider: 'codex_cli', plannerEffort: 'ultra' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true }))
  assert.match(ultra, /class="hx-mpick__card" data-level="ultra"[\s\S]*<b>Ultra<\/b>/)
})

test('Claude and Codex share one effort card; only the level names follow each app', () => {
  const claude = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerEffort: 'ultra' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true }))
  const codex = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerProvider: 'codex_cli', plannerEffort: 'ultra' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true }))
  for (const html of [claude, codex]) {
    assert.match(html, /class="hx-mpick__card" data-level="ultra"><svg class="hx-mpick__bolt"/)
    assert.match(html, /class="hx-mpick__reset" aria-label="Reset effort"/)
    assert.match(html, /<div class="hx-effort" data-level="ultra"><div class="hx-effort__track"/)
    assert.equal(html.match(/class="hx-effort__dot"/g).length, 6)
    assert.doesNotMatch(html, /data-variant|Faster|Recommended|hx-mpick__help|hx-effort__fill/)
  }
  assert.match(claude, /<b>Ultracode<\/b>[\s\S]*class="hx-mpick__model"[^>]*>Opus 5\.5<svg/)
  assert.match(codex, /<b>Ultra<\/b>[\s\S]*class="hx-mpick__model"[^>]*>GPT-6\.1 Sol<svg/)
  const low = renderToStaticMarkup(React.createElement(ModelPicker, { settings: { ...settings, plannerEffort: 'low' }, onSelectModel: () => {}, onEffort: () => {}, defaultOpen: true }))
  assert.match(low, /<b>Low<\/b>/)
})
