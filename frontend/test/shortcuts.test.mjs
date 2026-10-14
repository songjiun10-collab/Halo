import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { leaveToHalo, shortcutFor } from '../src/hooks/useShortcuts.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const press = (code, keys = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...keys })

test('with the page focused, HALO shortcuts stay with HALO and every other key goes to the page', () => {
  const halo = [['KeyF', { ctrlKey: true }], ['KeyR', { metaKey: true }], ['KeyT', { ctrlKey: true }], ['KeyW', { metaKey: true }],
    ['Equal', { ctrlKey: true }], ['Minus', { metaKey: true }], ['Digit0', { ctrlKey: true }], ['KeyL', { metaKey: true }],
    ['Digit3', { ctrlKey: true }], ['KeyK', { metaKey: true }], ['F5', {}], ['Slash', { metaKey: true }], ['Slash', { ctrlKey: true }]]
  for (const [code, keys] of halo) assert.equal(leaveToHalo(press(code, keys)), true, `${code} ${JSON.stringify(keys)}`)
  // Editing keys belong to the page. Alt+arrow moves by word in a Mac text field, so it is never taken from the page.
  const page = [['KeyC', { ctrlKey: true }], ['KeyA', { metaKey: true }], ['KeyZ', { ctrlKey: true }], ['KeyV', { metaKey: true }],
    ['Enter', {}], ['Tab', {}], ['Escape', {}], ['Backspace', {}], ['ArrowLeft', { altKey: true }], ['ArrowRight', { altKey: true }],
    ['Slash', { shiftKey: true }], ['KeyA', {}]]
  for (const [code, keys] of page) assert.equal(leaveToHalo(press(code, keys)), false, `${code} ${JSON.stringify(keys)}`)
})

test('the page frame lets HALO shortcuts through before it claims a key for the page', async () => {
  const frame = await fs.readFile(path.join(root, 'src/components/RemotePageFrame.tsx'), 'utf8')
  const keyDown = frame.slice(frame.indexOf('onKeyDown='), frame.indexOf('onKeyUp='))
  assert.ok(keyDown.includes('leaveToHalo(event.nativeEvent)'), 'the frame asks before it takes a key')
  assert.ok(keyDown.indexOf('leaveToHalo(') < keyDown.indexOf('stopPropagation'), '(the bug) Mod+F, Mod+R and the rest never reached HALO while the page had focus')
})

test('a question mark is only typing; the shortcut list opens with Mod+/, even from a text field', () => {
  // A single printable key must not be a shortcut (WCAG 2.1.4): Shift+/ types "?" everywhere.
  for (const target of [{ tagName: 'BODY' }, { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(shortcutFor(press('Slash', { shiftKey: true, target })), null, target.tagName)
  }
  for (const keys of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(shortcutFor(press('Slash', { ...keys, target: { tagName: 'INPUT' } }))?.action, 'help', JSON.stringify(keys))
  }
})

test('every shortcut in the table is recognised, with the tab ones waiting for a tab', () => {
  const cases = [
    [press('Period', { metaKey: true }), 'togglePin', false], [press('Period', { ctrlKey: true, shiftKey: true }), 'toggleChat', false],
    [press('F5'), 'reload', false], [press('ArrowLeft', { altKey: true }), 'back', false], [press('ArrowRight', { altKey: true }), 'forward', false],
    [press('KeyK', { metaKey: true }), 'newTask', false], [press('Comma', { ctrlKey: true }), 'settings', false],
    [press('KeyT', { metaKey: true }), 'newTab', true], [press('KeyW', { ctrlKey: true }), 'closeTab', true], [press('KeyR', { ctrlKey: true, shiftKey: true }), 'reload', true],
    [press('KeyF', { metaKey: true }), 'find', true], [press('NumpadAdd', { ctrlKey: true }), 'zoomIn', true], [press('Minus', { ctrlKey: true }), 'zoomOut', true],
    [press('Numpad0', { metaKey: true }), 'zoomReset', true], [press('KeyL', { metaKey: true }), 'focusOmni', true], [press('KeyL', { metaKey: true, shiftKey: true }), 'toggleSidebar', true],
    [press('KeyN', { ctrlKey: true }), 'newWindow', true], [press('Digit9', { metaKey: true }), 'selectTab', true],
    [press('BracketRight', { metaKey: true, shiftKey: true }), 'nextTab', true], [press('BracketLeft', { metaKey: true, shiftKey: true }), 'previousTab', true],
    [press('BracketLeft', { metaKey: true }), 'back', true], [press('BracketRight', { ctrlKey: true }), 'forward', true],
    [press('KeyA', { metaKey: true, shiftKey: true }), 'overview', true], [press('KeyS', { ctrlKey: true, shiftKey: true }), 'share', true],
  ]
  for (const [event, action, needsTab] of cases) assert.deepEqual([shortcutFor(event)?.action, shortcutFor(event)?.needsTab], [action, needsTab], JSON.stringify(event))
  assert.equal(shortcutFor(press('Digit3', { ctrlKey: true }))?.position, 3)
  for (const event of [press('KeyF'), press('Digit0', { metaKey: true, shiftKey: true }), press('KeyF', { metaKey: true, shiftKey: true }), press('Equal', { ctrlKey: true, altKey: true })]) {
    assert.equal(shortcutFor(event), null, JSON.stringify(event))
  }
})
