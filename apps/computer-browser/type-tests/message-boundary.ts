import port = require('../runtime-src/main/harness/message-port');
import mailbox = require('../runtime-src/main/harness/message-mailbox');

const pair = port.createLoopbackPair();
const client = new port.PortClient(pair[0]);
client.call('observe', [], { timeoutMs: 100, signal: new AbortController().signal });
const errorCode: unknown = new port.PortError('test', 'message').code;
const mailboxCode: string = new mailbox.MessageMailboxError('test', 'message').code;
void errorCode;
void mailboxCode;
// @ts-expect-error timeout is a duration, not a string
client.call('observe', [], { timeoutMs: '100' });
// @ts-expect-error transports cannot be arbitrary primitives
new port.PortClient(42);
