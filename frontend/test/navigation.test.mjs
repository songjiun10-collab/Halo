import assert from 'node:assert/strict'
import test from 'node:test'
import { addressTarget } from '../src/session/navigation.ts'

test('address entry accepts web addresses without converting search text into a command', () => {
  assert.equal(addressTarget(' example.com/path '), 'https://example.com/path')
  assert.equal(addressTarget('http://localhost:8080/'), 'http://localhost:8080/')
  assert.equal(addressTarget('//example.org/path'), 'https://example.org/path')
  assert.equal(addressTarget(''), null)
  assert.equal(addressTarget('   '), null)
  assert.equal(addressTarget('javascript:alert(1)'), 'javascript:alert(1)')
})
