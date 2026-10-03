import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const settingsLib = await vite.ssrLoadModule('/src/session/settings.ts')
const { SettingsView } = await vite.ssrLoadModule('/src/components/SettingsPanel.tsx')
test.after(() => vite.close())

const base = { version: 5, executionMode: 'sequential', permissionMode: 'browse', plannerEffort: 'medium', plannerEffortMode: 'auto', memoryPolicy: 'budgeted', plannerProvider: 'claude_code', mcpProviders: [] }

test('fast mode says where it applies for the selected model', () => {
  const { fastModeSupport } = settingsLib
  assert.equal(fastModeSupport({ ...base, plannerProvider: 'none' }), 'no_planner')
  assert.equal(fastModeSupport(base), 'claude_opus', 'unpinned Claude runs Opus')
  assert.equal(fastModeSupport({ ...base, plannerModel: 'claude-opus-4-5-20251101' }), 'claude_opus')
  assert.equal(fastModeSupport({ ...base, plannerModel: 'claude-sonnet-5-5' }), 'claude_other')
  assert.equal(fastModeSupport({ ...base, plannerProvider: 'codex_cli', plannerModel: 'gpt-5.5' }), 'codex')
})

test('saving a setting returns the host result or null, never throws', async () => {
  const { saveSetting } = settingsLib
  const calls = []
  const api = { updateHostSettings: async (patch) => { calls.push(patch); return { ...base, ...patch } } }
  assert.deepEqual(await saveSetting(api, { plannerFast: true }), { ...base, plannerFast: true })
  assert.deepEqual(calls, [{ plannerFast: true }])
  assert.equal(await saveSetting({ updateHostSettings: async () => { throw new Error('no') } }, { executionMode: 'parallel' }), null)
  assert.equal(await saveSetting(undefined, { executionMode: 'parallel' }), null)
})

test('the settings view shows every runtime setting with its current value', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsView, { settings: { ...base, plannerFast: true }, saving: false, error: null, onChange: () => {} }))
  assert.match(html, /role="dialog"[^>]*aria-label="Settings"/)
  for (const label of ['Observe', 'Browse', 'Interact', 'Full']) assert.match(html, new RegExp(`>${label}<`))
  assert.match(html, /aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*>Browse</, 'the current permission is the checked card')
  assert.match(html, /Skips approval/, 'full mode warns that it bypasses approval')
  assert.match(html, />One at a time</)
  assert.match(html, />In parallel</)
  assert.match(html, /aria-label="Planner model"/)
  assert.match(html, /<option[^>]*value="claude-opus-5-5"/)
  assert.match(html, /<option[^>]*value="gpt-6.1-sol"/)
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-label="Fast mode"|aria-label="Fast mode"[^>]*role="switch"[^>]*aria-checked="true"|role="switch"[^>]*aria-label="Fast mode"[^>]*aria-checked="true"/)
  assert.match(html, /credits/, 'Claude fast mode cost is stated')
})

test('settings is a full panel with a back header, labelled sections and selectable cards', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsView, { settings: base, saving: false, error: null, onChange: () => {}, onClose: () => {} }))
  assert.match(html, /class="hx-settings"/, 'a full panel, not the floating activity card')
  assert.match(html, /class="hx-settings__head"[\s\S]*aria-label="Close settings"[\s\S]*<h2>Settings<\/h2>/)
  for (const label of ['Planner', 'What the agent may do', 'Running tasks']) assert.match(html, new RegExp(`class="hx-settings__label"[^>]*>${label}<`))
  assert.match(html, /class="hx-perm"[^>]*data-selected=""[^>]*aria-checked="true"[^>]*>[\s\S]*?Browse/, 'the selected permission is a card')
  assert.match(html, /role="radiogroup"[^>]*aria-label="Permission mode"/)
  assert.match(html, /data-provider="claude_code"[\s\S]*Claude[\s\S]*data-provider="codex_cli"[\s\S]*Codex/)
  assert.match(html, /aria-label="Use Claude"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Use Claude"/)
  assert.doesNotMatch(html, /type="password"/i, 'settings never collects provider keys')
})

test('turning a provider row on picks its default model, and off turns the planner off', () => {
  const patches = []
  const view = SettingsView({ settings: base, saving: false, error: null, onChange: (p) => patches.push(p), onClose: () => {} })
  const find = (node, label) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const n of node) { const hit = find(n, label); if (hit) return hit } return null }
    if (node.props?.['aria-label'] === label) return node
    if (typeof node.type === 'function') return find(node.type(node.props), label)
    return find(node.props?.children, label)
  }
  find(view, 'Use Codex').props.onClick()
  find(view, 'Use Claude').props.onClick()
  assert.deepEqual(patches, [{ plannerProvider: 'codex_cli', plannerModel: 'gpt-6.1-sol' }, { plannerProvider: 'none' }])
})

test('fast mode is off and explained when the model cannot use it', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsView, { settings: { ...base, plannerModel: 'claude-sonnet-5-5' }, saving: false, error: null, onChange: () => {} }))
  assert.match(html, /Opus only/)
  const none = renderToStaticMarkup(React.createElement(SettingsView, { settings: null, saving: false, error: null, onChange: () => {} }))
  assert.match(none, /Loading settings/)
})

test('the toolbar opens settings and the app wires it as an overlay that hides the page', async () => {
  const toolbar = await fs.readFile(path.join(root, 'src/components/Toolbar.tsx'), 'utf8')
  assert.match(toolbar, /aria-label="Settings"/)
  const app = await fs.readFile(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /<SettingsPanel/)
  assert.match(app, /!settingsOpen && !noticeShown\.item/, 'the native page is hidden while settings are open')
  const shortcuts = await fs.readFile(path.join(root, 'src/hooks/useShortcuts.ts'), 'utf8')
  assert.match(shortcuts, /keys: 'Mod\+,'/)
  assert.match(shortcuts, /e\.code === 'Comma'/)
})
