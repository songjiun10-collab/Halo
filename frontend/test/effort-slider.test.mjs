import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { EffortSlider } = await vite.ssrLoadModule('/src/components/EffortSlider.tsx')
const { ModelPicker } = await vite.ssrLoadModule('/src/components/ModelPicker.tsx')
const { PLANNER_EFFORTS, saveEffort } = await vite.ssrLoadModule('/src/session/planner-effort.ts')
test.after(() => vite.close())

test('the effort bar offers the six host effort levels and shows the current one', () => {
  assert.deepEqual(PLANNER_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  const html = renderToStaticMarkup(React.createElement(EffortSlider, { value: 'high', onChange: () => {} }))
  assert.match(html, /type="range"/)
  assert.match(html, /min="0"/)
  assert.match(html, /max="5"/)
  assert.match(html, /value="2"/)
  assert.match(html, /aria-valuetext="High"/)
  assert.equal(html.match(/class="hx-effort__dot"/g).length, 6)
  assert.match(html, /class="hx-effort__knob" style="left:40%"/)
  assert.match(html, /<div class="hx-effort" data-level="high">/)
  assert.match(renderToStaticMarkup(React.createElement(EffortSlider, { value: 'max', onChange: () => {}, disabled: true })), /disabled=""/)
})

test('saving an effort sends only plannerEffort and returns the host settings, or null on failure', async () => {
  const calls = []
  const api = { updateHostSettings: async (patch) => { calls.push(patch); return { plannerEffort: patch.plannerEffort } } }
  assert.deepEqual(await saveEffort(api, 'xhigh'), { plannerEffort: 'xhigh' })
  assert.deepEqual(calls, [{ plannerEffort: 'xhigh' }])
  assert.equal(await saveEffort(api, 'turbo'), null, 'an unknown level is never sent')
  assert.equal(calls.length, 1)
  assert.equal(await saveEffort({ updateHostSettings: async () => { throw new Error('no') } }, 'low'), null)
  assert.equal(await saveEffort(undefined, 'low'), null)
})

test('as in the design, effort lives in the model picker popover between the input and Go', () => {
  const settings = { version: 5, executionMode: 'sequential', permissionMode: 'browse', plannerEffort: 'xhigh', memoryPolicy: 'budgeted', plannerProvider: 'claude_code' }
  const props = { settings, onSelectModel: () => {}, onEffort: () => {} }
  const closed = renderToStaticMarkup(React.createElement(ModelPicker, props))
  assert.match(closed, /class="hx-mpick"/)
  assert.match(closed, /class="hx-mpick__toggle" aria-haspopup="true" aria-expanded="false"/)
  assert.match(closed, /<span>Claude Opus 5.5<\/span>/)
  assert.doesNotMatch(closed, /hx-mpick__pop/)
  const open = renderToStaticMarkup(React.createElement(ModelPicker, { ...props, defaultOpen: true }))
  assert.match(open, /class="hx-mpick" data-open="true"/)
  assert.match(open, /<div class="hx-mpick__pop" data-view="effort">/)
  assert.match(open, /<b>Extra high<\/b>[\s\S]*>Opus 5\.5<svg[\s\S]*<div class="hx-effort" data-level="xhigh">/)
  const models = renderToStaticMarkup(React.createElement(ModelPicker, { ...props, defaultOpen: true, defaultView: 'models' }))
  assert.match(models, /class="hx-mpick__back"[\s\S]*<p>Model<\/p>/)
  assert.match(models, /role="radio" aria-checked="true"[^>]*>.*Opus 5.5/)
  assert.doesNotMatch(models, /Gemini/, 'only models the host actually wires are listed')
  const none = renderToStaticMarkup(React.createElement(ModelPicker, { ...props, settings: null }))
  assert.match(none, /<span>Model<\/span>/)
  assert.match(none, /disabled=""/, 'nothing to pick until host settings load')
})

test('Ultra, as in the Codex app, is the last step and lights the whole track', () => {
  const html = renderToStaticMarkup(React.createElement(EffortSlider, { value: 'ultra', onChange: () => {} }))
  assert.match(html, /<div class="hx-effort" data-level="ultra">/)
  assert.match(html, /value="5"/)
  assert.match(html, /aria-valuetext="Ultra"/)
  assert.match(html, /class="hx-effort__knob" style="left:100%"/)
  assert.match(html, /class="hx-effort__stars"/)
})

test('only Ultra sparkles: lower levels have no stars in either style', () => {
  for (const naming of ['codex', 'claude']) {
    assert.match(renderToStaticMarkup(React.createElement(EffortSlider, { value: 'ultra', onChange: () => {}, naming })), /class="hx-effort__stars"/, naming)
    for (const value of ['low', 'high', 'max']) {
      assert.doesNotMatch(renderToStaticMarkup(React.createElement(EffortSlider, { value, onChange: () => {}, naming })), /hx-effort__stars/, `${naming} ${value}`)
    }
  }
})

test('a drag position snaps to the nearest level only on release', async () => {
  const { effortAtFraction } = await vite.ssrLoadModule('/src/components/EffortSlider.tsx')
  assert.equal(effortAtFraction(0), 'low')
  assert.equal(effortAtFraction(0.09), 'low')
  assert.equal(effortAtFraction(0.11), 'medium')
  assert.equal(effortAtFraction(0.49), 'high')
  assert.equal(effortAtFraction(0.95), 'ultra')
  assert.equal(effortAtFraction(-3), 'low', 'past the start clamps')
  assert.equal(effortAtFraction(7), 'ultra', 'past the end clamps')
  const html = renderToStaticMarkup(React.createElement(EffortSlider, { value: 'high', onChange: () => {} }))
  assert.doesNotMatch(html, /data-dragging/, 'not dragging until a pointer goes down')
})

test('Max colours the track only up to the knob; the Ultra stretch past it stays plain', () => {
  const max = renderToStaticMarkup(React.createElement(EffortSlider, { value: 'max', onChange: () => {} }))
  assert.match(max, /class="hx-effort__fill"[^>]*style="width:calc\(80% \+ 34px\)"/)
  assert.match(max, /left:100%" data-ahead="true"/, 'the Ultra dot past the knob is marked as ahead')
  assert.equal(max.match(/data-ahead/g).length, 1)
  // Below Max the same fill runs to the knob (blue in CSS); Ultra lights the whole track instead.
  for (const [value, at] of [['low', '0%'], ['high', '40%'], ['xhigh', '60%']]) {
    assert.match(renderToStaticMarkup(React.createElement(EffortSlider, { value, onChange: () => {} })), new RegExp(`class="hx-effort__fill"[^>]*style="width:calc\\(${at} \\+ 34px\\)"`), value)
  }
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(EffortSlider, { value: 'ultra', onChange: () => {} })), /hx-effort__fill/)
})
