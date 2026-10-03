'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('communication CommonJS exports and error serialization retain their legacy shape', () => {
  const port = require('../main/harness/message-port');
  const mailbox = require('../main/harness/message-mailbox');
  assert.deepEqual(Object.keys(port), ['PortError', 'PortClient', 'assertJsonClean',
    'createLoopbackPair', 'serveBrowser', 'servePlanner', 'createRemoteBrowser', 'createRemotePlanner']);
  assert.deepEqual(Object.keys(mailbox), ['MessageMailbox', 'MessageMailboxError', 'MAX_PENDING_PER_CONVERSATION']);
  assert.equal(Object.hasOwn(port, '__esModule'), false);
  assert.equal(Object.hasOwn(mailbox, '__esModule'), false);
  for (const [ErrorClass, name] of [[port.PortError, 'PortError'], [mailbox.MessageMailboxError, 'MessageMailboxError']]) {
    const error = new ErrorClass('test_code', 'test message');
    assert.deepEqual(Object.keys(error), ['name', 'code']);
    assert.equal(JSON.stringify(error), `{"name":"${name}","code":"test_code"}`);
    assert.equal(error.message, 'test message');
  }
});
