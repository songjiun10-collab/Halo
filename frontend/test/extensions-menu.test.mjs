import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { ExtensionsMenu } = await vite.ssrLoadModule('/src/components/ExtensionsMenu.tsx')
test.after(() => vite.close())

test('extensions menu renders nothing until the host lists extensions (server render, no window)', () => {
  assert.equal(renderToStaticMarkup(React.createElement(ExtensionsMenu)), '')
})
