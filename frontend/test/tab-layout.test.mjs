import assert from 'node:assert/strict'
import test from 'node:test'
import { TAB_LAYOUT_KEY, loadTabLayout, otherTabLayout, parseTabLayout, saveTabLayout } from '../src/session/tab-layout.ts'

test('only "horizontal" brings back the strip; anything else keeps tabs in the sidebar', () => {
  assert.equal(parseTabLayout('horizontal'), 'horizontal')
  for (const raw of ['vertical', '', null, undefined, 'Horizontal', 1, {}]) assert.equal(parseTabLayout(raw), 'vertical')
  assert.equal(otherTabLayout('horizontal'), 'vertical')
  assert.equal(otherTabLayout('vertical'), 'horizontal')
})

test('the choice round-trips through storage and survives storage failing', () => {
  const data = new Map()
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
  assert.equal(loadTabLayout(storage), 'vertical')
  saveTabLayout('horizontal', storage)
  assert.equal(data.get(TAB_LAYOUT_KEY), 'horizontal')
  assert.equal(loadTabLayout(storage), 'horizontal')
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(loadTabLayout(broken), 'vertical')
  assert.doesNotThrow(() => saveTabLayout('vertical', broken))
  assert.equal(loadTabLayout(undefined), 'vertical')
})
