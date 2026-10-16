import assert from 'node:assert/strict'
import test from 'node:test'
import { TAB_LAYOUT_KEY, loadTabLayout, otherTabLayout, parseTabLayout, saveTabLayout } from '../src/session/tab-layout.ts'

test('only "vertical" selects vertical tabs; anything else keeps the horizontal strip', () => {
  assert.equal(parseTabLayout('vertical'), 'vertical')
  for (const raw of ['horizontal', '', null, undefined, 'Vertical', 1, {}]) assert.equal(parseTabLayout(raw), 'horizontal')
  assert.equal(otherTabLayout('horizontal'), 'vertical')
  assert.equal(otherTabLayout('vertical'), 'horizontal')
})

test('the choice round-trips through storage and survives storage failing', () => {
  const data = new Map()
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
  assert.equal(loadTabLayout(storage), 'horizontal')
  saveTabLayout('vertical', storage)
  assert.equal(data.get(TAB_LAYOUT_KEY), 'vertical')
  assert.equal(loadTabLayout(storage), 'vertical')
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(loadTabLayout(broken), 'horizontal')
  assert.doesNotThrow(() => saveTabLayout('vertical', broken))
  assert.equal(loadTabLayout(undefined), 'horizontal')
})
