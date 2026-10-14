import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { HaloSheet } = await vite.ssrLoadModule('/src/components/HaloSheet.tsx')
const { lendSummary, approvalKey } = await vite.ssrLoadModule('/src/session/approval-view.ts')
const { LeaseChip } = await vite.ssrLoadModule('/src/components/LeaseChip.tsx')
const { leaseLabel } = await vite.ssrLoadModule('/src/session/lease-label.ts')
const { LockChips } = await vite.ssrLoadModule('/src/components/LockChips.tsx')
const { lockFromChips } = await vite.ssrLoadModule('/src/session/lock-chips.ts')
test.after(() => vite.close())
const noop = () => {}

const approval = { taskId: 't', id: 'r', action: 'Open github.com', request: 'navigate', createdAt: 'now', widen: true, leaseOffer: { action: 'navigate', origin: 'https://github.com' } }

test('the sheet offers Lend only when the request has a lease offer, and says when the mode is widened', () => {
  const html = renderToStaticMarkup(React.createElement(HaloSheet, { approval, onApprove: noop, onDeny: noop, onTakeOver: noop, onLend: noop }))
  assert.match(html, />Adjust…</)
  assert.match(html, /Allow github.com · 10 min/)
  assert.match(html, /outside the current permission mode/)
  const plain = renderToStaticMarkup(React.createElement(HaloSheet, { approval: { ...approval, widen: false, leaseOffer: null }, onApprove: noop, onDeny: noop, onTakeOver: noop, onLend: noop }))
  assert.doesNotMatch(plain, /Adjust…|10 min/)
  assert.doesNotMatch(plain, /outside the current permission mode/)
})

test('lend terms read as one line and can only shrink', () => {
  assert.equal(lendSummary(approval.leaseOffer, { minutes: 10, uses: 3 }), 'navigate · github.com · 10 min · 3 uses')
  assert.equal(lendSummary(approval.leaseOffer, { minutes: 1, uses: 1 }), 'navigate · github.com · 1 min · 1 use')
})

test('the lease chip shows who borrowed what for how long, and revokes', () => {
  const leases = [{ id: 'l1', action: 'navigate', origin: 'https://github.com', expiresAt: 600_000, usesLeft: 2 }]
  assert.equal(leaseLabel('Atlas', leases[0], 120_000), 'Atlas borrowed: navigate · github.com · 8 min · 2 left')
  const html = renderToStaticMarkup(React.createElement(LeaseChip, { leases, now: 120_000, agent: 'Atlas', onRevoke: noop }))
  assert.match(html, /aria-label="Revoke lease navigate on github.com"/)
  assert.equal(renderToStaticMarkup(React.createElement(LeaseChip, { leases: [], now: 0, agent: 'Atlas', onRevoke: noop })), '')
})

test('lock chips turn into host rules; enforced rules are marked as such', () => {
  assert.deepEqual(lockFromChips(new Set()), undefined)
  assert.deepEqual(lockFromChips(new Set(['no_links'])), { rules: [{ kind: 'deny_action', action: 'follow_link' }] })
  assert.deepEqual(lockFromChips(new Set(['this_site']), 'https://github.com/x'), { rules: [{ kind: 'allow_origins', origins: ['https://github.com'] }] })
  assert.equal(lockFromChips(new Set(['this_site'])), undefined, 'no site to pin without a page')
  const html = renderToStaticMarkup(React.createElement(LockChips, { value: new Set(['no_links']), onChange: noop }))
  assert.match(html, /aria-pressed="true"[^>]*>[^<]*Don’t follow links/)
  assert.match(html, /Enforced by Halo/)
})

test('sheet state is keyed by the decision, not by the object derive() rebuilds', () => {
  assert.equal(approvalKey(approval), approvalKey({ ...approval }))
  assert.notEqual(approvalKey(approval), approvalKey({ ...approval, id: 'r2' }))
  const src = readFileSync(path.join(root, 'src/components/HaloSheet.tsx'), 'utf8')
  assert.match(src, /\[approval\.id, approval\.taskId\]/)
  assert.doesNotMatch(src, /\[approval\]/)
})

test('expired leases are hidden', () => {
  const leases = [{ id: 'l1', action: 'navigate', origin: 'https://github.com', expiresAt: 100, usesLeft: 2 }]
  assert.equal(renderToStaticMarkup(React.createElement(LeaseChip, { leases, now: 100, agent: 'Atlas', onRevoke: noop })), '')
})

test('Activity names a running or merged background branch without leaking findings', async () => {
  const { Activity } = await vite.ssrLoadModule('/src/components/Activity.tsx')
  const branch = (state) => ({ id: 'b', approvalId: 'r', state, steps: [{ url: 'https://rival.test/p', purpose: 'compare prices' }], findings: 1, startedAt: 0 })
  const render = (state) => renderToStaticMarkup(React.createElement(Activity, { leaving: false, onClose: noop, session: { task: 't', timeline: [], snapshot: { branches: [branch(state)] } } }))
  assert.match(render('running'), /Reading in the background while you decide — compare prices/)
  assert.match(render('merged'), /Background reading added to the task/)
  assert.doesNotMatch(render('discarded'), /background/i)
})
