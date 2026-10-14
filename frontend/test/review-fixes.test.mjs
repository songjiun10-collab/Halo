import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { activeAgentCount } = await vite.ssrLoadModule('/src/agent/agent-counts.ts')
const { AgentForm } = await vite.ssrLoadModule('/src/agent/AgentForms.tsx')
test.after(() => vite.close())

const agent = { id: '11111111-1111-4111-8111-111111111111', name: 'Scout', title: 'Research', description: '', avatar: { shape: 'star', color: 'blue' }, instructions: 'Be brief', capabilityId: 'browser', archived: false }

test('Agent model picker includes the OpenCode planner models', () => {
  const html = renderToStaticMarkup(React.createElement(AgentForm, { api: {}, agent, onBack: () => {}, onSaved: () => {} }))
  assert.match(html, /<optgroup label="OpenCode">[\s\S]*opencode-default/)
})

test('archived Agents do not consume the active Agent creation limit', () => {
  const records = Array.from({ length: 50 }, (_, index) => ({ ...agent, id: `agent-${index}`, archived: true }))
  assert.equal(activeAgentCount(records), 0)
  assert.equal(activeAgentCount([...records, { ...agent, id: 'active', archived: false }]), 1)
})
