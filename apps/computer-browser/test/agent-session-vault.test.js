'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionVault } = require('../main/harness/session-vault');

const P = 'persist:halo-agent-0123abcd-0123-4567-89ab-0123456789ab';
const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
function setup(available = true) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'vault');
  const storage = { isEncryptionAvailable: () => available, encryptString: (t) => xor(Buffer.from(t, 'utf8')), decryptString: (d) => xor(d).toString('utf8') };
  return { dir, vault: createSessionVault({ dir, storage }) };
}
const cookie = (o = {}) => ({ name: 'sid', value: 'SECRETVALUE', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', ...o });

test('save/load round trip', async () => {
  const { vault } = setup();
  const cookies = [cookie(), cookie({ name: 'b', expires: Date.now() / 1000 + 1000 })];
  assert.equal(await vault.save(P, cookies), true);
  assert.deepEqual(await vault.load(P), cookies);
});
test('non-target partitions are ignored', async () => {
  const { vault, dir } = setup();
  for (const p of ['halo-task-1', 'persist:halo-task-1', 'persist:halo-agent-../x', 'persist:halo-child-0123abcd-0123-4567-89ab-0123456789ab']) {
    assert.equal(vault.isPersistentPartition(p), false);
    assert.equal(await vault.save(p, [cookie()]), false);
    assert.deepEqual(await vault.load(p), []);
  }
  assert.equal(fs.existsSync(dir), false);
});
test('fails closed without encryption', async () => {
  const { vault, dir } = setup(false);
  assert.equal(await vault.save(P, [cookie()]), false);
  assert.equal(fs.existsSync(dir), false);
});
test('disk is encrypted with 0600/0700 modes', async () => {
  const { vault, dir } = setup();
  await vault.save(P, [cookie()]);
  const file = path.join(dir, '0123abcd-0123-4567-89ab-0123456789ab.session');
  assert.equal(fs.readFileSync(file).includes('SECRETVALUE'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), ['0123abcd-0123-4567-89ab-0123456789ab.session']);
});
test('corrupt file and decrypt failure load empty', async () => {
  const { vault, dir } = setup();
  await vault.save(P, [cookie()]);
  const file = path.join(dir, '0123abcd-0123-4567-89ab-0123456789ab.session');
  fs.writeFileSync(file, Buffer.from('garbage'));
  assert.deepEqual(await vault.load(P), []);
  const throwing = createSessionVault({ dir, storage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(1), decryptString: () => { throw new Error('bad'); } } });
  assert.deepEqual(await throwing.load(P), []);
});
test('expired and invalid cookies are dropped on load', async () => {
  const { vault } = setup();
  await vault.save(P, [cookie(), cookie({ name: 'old', expires: 1000 }), cookie({ name: 'nd', domain: '' }), cookie({ name: 'nv', value: 5 }), cookie({ name: 'bad', domain: 'a/b' })]);
  assert.deepEqual((await vault.load(P)).map((c) => c.name), ['sid']);
});
test('more than 1500 cookies is refused', async () => {
  const { vault } = setup();
  assert.equal(await vault.save(P, Array.from({ length: 1501 }, (_, i) => cookie({ name: `c${i}` }))), false);
});
test('clear removes the file', async () => {
  const { vault } = setup();
  await vault.save(P, [cookie()]);
  await vault.clear(P);
  assert.deepEqual(await vault.load(P), []);
  await vault.clear(P);
});

test('an unreadable existing file is never overwritten by this process', async () => {
  const { dir, vault } = setup();
  assert.equal(await vault.save(P, [cookie()]), true);
  const file = path.join(dir, '0123abcd-0123-4567-89ab-0123456789ab.session');
  const original = fs.readFileSync(path.join(file));
  const flaky = createSessionVault({ dir, storage: { isEncryptionAvailable: () => true, encryptString: (t) => xor(Buffer.from(t, 'utf8')), decryptString() { throw new Error('keychain_locked'); } } });
  assert.deepEqual(await flaky.load(P), []);
  assert.equal(await flaky.save(P, [cookie({ value: 'other' })]), false);
  assert.deepEqual(fs.readFileSync(file), original);
});
test('concurrent saves land in order', async () => {
  const { vault } = setup();
  await Promise.all([vault.save(P, [cookie({ value: 'old' })]), vault.save(P, [cookie({ value: 'new' })])]);
  assert.equal((await vault.load(P))[0].value, 'new');
});
