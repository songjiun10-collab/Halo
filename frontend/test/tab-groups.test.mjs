import assert from 'node:assert/strict'
import test from 'node:test'
import { TAB_GROUPS_KEY, addToGroup, createGroup, groupOf, loadGroups, parseGroups, pruneGroups, removeFromGroup, renameGroup, saveGroups, toggleCollapsed, ungroup, ungroupAll } from '../src/session/tab-groups.ts'

test('a tab belongs to one group: creating or adding moves it out of its old group', () => {
  let g = createGroup([], 'a', 'g1', 'Work')
  g = addToGroup(g, 'g1', 'b')
  g = createGroup(g, 'b', 'g2', 'Reading')
  assert.deepEqual(g.map((x) => [x.id, x.tabIds]), [['g1', ['a']], ['g2', ['b']]])
  g = addToGroup(g, 'g1', 'b')
  assert.deepEqual(g.map((x) => [x.id, x.tabIds]), [['g1', ['a', 'b']]], 'the emptied group is gone')
  assert.equal(addToGroup(g, 'missing', 'c'), g, 'an unknown group changes nothing')
  assert.equal(groupOf(g, 'b')?.id, 'g1')
  assert.equal(groupOf(g, 'zzz'), undefined)
})

test('moving the last tab out of a group closes the group (the standard behaviour)', () => {
  let g = createGroup([], 'a', 'g1')
  g = addToGroup(g, 'g1', 'b')
  g = removeFromGroup(g, 'a')
  assert.deepEqual(g.map((x) => x.tabIds), [['b']])
  g = removeFromGroup(g, 'b')
  assert.deepEqual(g, [], 'no empty group is left behind')
  assert.deepEqual(removeFromGroup([], 'x'), [])
})

test('one action ungroups everything, and a single group can be dissolved', () => {
  let g = createGroup([], 'a', 'g1')
  g = createGroup(g, 'b', 'g2')
  g = createGroup(g, 'c', 'g3')
  assert.deepEqual(ungroup(g, 'g2').map((x) => x.id), ['g1', 'g3'])
  assert.deepEqual(ungroupAll(), [])
})

test('closed tabs and emptied groups are pruned; nothing changed returns the same array', () => {
  let g = createGroup([], 'a', 'g1')
  g = addToGroup(g, 'g1', 'b')
  g = createGroup(g, 'c', 'g2')
  assert.equal(pruneGroups(g, ['a', 'b', 'c', 'd']), g)
  assert.deepEqual(pruneGroups(g, ['b', 'd']).map((x) => [x.id, x.tabIds]), [['g1', ['b']]])
})

test('rename trims and bounds the name, an empty name keeps the old one; collapse toggles', () => {
  let g = createGroup([], 'a', 'g1', 'Work')
  assert.equal(renameGroup(g, 'g1', '  Long   name  ')[0].name, 'Long name')
  assert.equal(renameGroup(g, 'g1', 'x'.repeat(100))[0].name.length, 40)
  assert.equal(renameGroup(g, 'g1', '   ')[0].name, 'Work')
  assert.equal(toggleCollapsed(g, 'g1')[0].collapsed, true)
  assert.equal(toggleCollapsed(toggleCollapsed(g, 'g1'), 'g1')[0].collapsed, false)
})

test('stored data is untrusted: malformed groups are dropped and a tab stays in its first group', () => {
  const parsed = parseGroups([
    { id: 'g1', name: 'A', collapsed: true, tabIds: ['a', 'b', 'a'] },
    { id: 'g1', name: 'dup id', tabIds: ['x'] },
    { id: 'g2', name: 5, tabIds: ['b', 'c'] },
    { id: 'g3', tabIds: [] },
    { id: '', tabIds: ['q'] },
    null, 'text', { id: 'g4', tabIds: 'nope' },
  ])
  assert.deepEqual(parsed, [
    { id: 'g1', name: 'A', collapsed: true, tabIds: ['a', 'b'] },
    { id: 'g2', name: 'Group', collapsed: false, tabIds: ['c'] },
  ])
  assert.deepEqual(parseGroups('x'), [])
})

test('groups round-trip through storage and survive storage failing or holding junk', () => {
  const data = new Map()
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
  assert.deepEqual(loadGroups(storage), [])
  const g = createGroup([], 'a', 'g1', 'Work')
  saveGroups(g, storage)
  assert.deepEqual(loadGroups(storage), g)
  data.set(TAB_GROUPS_KEY, '{not json')
  assert.deepEqual(loadGroups(storage), [])
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.deepEqual(loadGroups(broken), [])
  assert.doesNotThrow(() => saveGroups(g, broken))
  assert.deepEqual(loadGroups(undefined), [])
})
