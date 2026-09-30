'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const names = ['harness-contracts', 'task-profile-contracts', 'harness-profile', 'capability-registry'];
const packageRoot = path.resolve(__dirname, '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'halo-runtime-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'runtime-src/shared'), { recursive: true });
  await fs.mkdir(path.join(root, 'shared'));
  await fs.mkdir(path.join(root, 'node_modules/typescript'), { recursive: true });
  // Copy the real compiler, not a fake compiler or symlinked dependency.
  await fs.cp(path.join(packageRoot, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), { recursive: true });
  const config = {
    compilerOptions: { strict: true, noEmitOnError: true, allowJs: false, target: 'ES2022', module: 'CommonJS',
      rootDir: 'runtime-src/shared', newLine: 'lf', types: [], declaration: false, sourceMap: false,
      incremental: false, importHelpers: false, removeComments: false },
    files: names.map(name => `runtime-src/shared/${name}.ts`),
  };
  await fs.writeFile(path.join(root, 'tsconfig.runtime.json'), JSON.stringify(config));
  for (const name of names) {
    await fs.writeFile(path.join(root, `runtime-src/shared/${name}.ts`), `const value: string = "${name}";\nexport = { value };\n`);
    await fs.writeFile(path.join(root, `shared/${name}.js`), `old ${name}\n`);
  }
  return root;
}
async function snapshot(root) {
  return Promise.all(names.map(name => fs.readFile(path.join(root, `shared/${name}.js`), 'utf8')));
}
async function tool() { return require('../tools/build-runtime.js').runRuntimeBuild; }

test('explicit build publishes deterministic CommonJS and check never mutates files', async t => {
  const root = await fixture(t);
  const run = await tool();
  await run({ projectRoot: root, mode: 'write' });
  const first = await snapshot(root);
  assert.match(first[0], /Generated from runtime-src\/shared\/harness-contracts.ts/);
  assert.equal(require(path.join(root, 'shared/harness-contracts.js')).value, 'harness-contracts');
  await run({ projectRoot: root, mode: 'check' });
  assert.deepEqual(await snapshot(root), first);
  await run({ projectRoot: root, mode: 'write' });
  assert.deepEqual(await snapshot(root), first);
  assert.deepEqual((await fs.readdir(path.join(root, 'shared'))).sort(), names.map(n => `${n}.js`).sort());
});

test('published runtime files retain readable checkout permissions', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'shared/harness-contracts.js');
  await fs.chmod(output, 0o644);
  await (await tool())({ projectRoot: root, mode: 'write' });
  assert.equal((await fs.stat(output)).mode & 0o777, 0o644);
});

test('stale and missing output reject read-only check without repairing artifacts', async t => {
  const root = await fixture(t);
  const run = await tool();
  const before = await snapshot(root);
  await assert.rejects(run({ projectRoot: root, mode: 'check' }), { code: 'RUNTIME_STALE' });
  assert.deepEqual(await snapshot(root), before);
  await fs.unlink(path.join(root, 'shared/harness-profile.js'));
  await assert.rejects(run({ projectRoot: root, mode: 'check' }), { code: 'RUNTIME_MISSING' });
  await assert.rejects(fs.stat(path.join(root, 'shared/harness-profile.js')), { code: 'ENOENT' });
});

test('compiler error preserves all previously published bytes', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  await fs.writeFile(path.join(root, 'runtime-src/shared/harness-contracts.ts'), 'const value: string = 123; export = { value };\n');
  await assert.rejects((await tool())({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_COMPILE' });
  assert.deepEqual(await snapshot(root), before);
  assert.equal((await fs.readdir(root)).some(n => n.includes('lock')), false);
});

test('unsupported compiler output path cannot write outside the four-file cohort', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const configPath = path.join(root, 'tsconfig.runtime.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.compilerOptions.outFile = path.join(root, 'outside.js');
  await fs.writeFile(configPath, JSON.stringify(config));
  await assert.rejects((await tool())({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_CONFIG' });
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(fs.stat(path.join(root, 'outside.js')), { code: 'ENOENT' });
});

test('symlinked source, output and parent directory are refused before publication', async t => {
  const root = await fixture(t);
  const run = await tool();
  const before = await snapshot(root);
  const source = path.join(root, 'runtime-src/shared/harness-contracts.ts');
  await fs.rename(source, `${source}.real`);
  await fs.symlink(`${source}.real`, source);
  await assert.rejects(run({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_PATH' });
  assert.deepEqual(await snapshot(root), before);
  await fs.unlink(source); await fs.rename(`${source}.real`, source);
  const output = path.join(root, 'shared/harness-contracts.js');
  await fs.rename(output, `${output}.real`); await fs.symlink(`${output}.real`, output);
  await assert.rejects(run({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_PATH' });
  assert.equal(await fs.readFile(`${output}.real`, 'utf8'), before[0]);
  await fs.unlink(output); await fs.rename(`${output}.real`, output);
  await fs.rename(path.join(root, 'shared'), path.join(root, 'shared-real'));
  await fs.symlink(path.join(root, 'shared-real'), path.join(root, 'shared'));
  await assert.rejects(run({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_PATH' });
});

test('held publisher lock is preserved and refuses another writer', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  await fs.writeFile(path.join(root, '.runtime-build.lock'), 'other owner');
  await assert.rejects((await tool())({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_LOCKED' });
  assert.equal(await fs.readFile(path.join(root, '.runtime-build.lock'), 'utf8'), 'other owner');
  assert.deepEqual(await snapshot(root), before);
});

test('source change during compilation aborts publication', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const original = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const temporary = await original(...args);
    await fs.appendFile(path.join(root, 'runtime-src/shared/harness-contracts.ts'), '// changed during build\n');
    return temporary;
  });
  await assert.rejects((await tool())({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_CHANGED' });
  assert.deepEqual(await snapshot(root), before);
});

test('unexpected compiler output prevents all publication', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const original = fs.readdir;
  t.mock.method(fs, 'readdir', async (...args) => {
    const files = await original(...args);
    return path.basename(args[0]).startsWith('halo-runtime-') ? [...files, 'unexpected.d.ts'] : files;
  });
  await assert.rejects((await tool())({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_OUTPUT' });
  assert.deepEqual(await snapshot(root), before);
});

test('partial publication is detectable and explicit rebuild repairs it', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const run = await tool();
  const original = fs.rename;
  let replacements = 0;
  const injected = t.mock.method(fs, 'rename', async (...args) => {
    replacements += 1;
    if (replacements === 2) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    return original(...args);
  });
  await assert.rejects(run({ projectRoot: root, mode: 'write' }), { code: 'RUNTIME_IO' });
  injected.mock.restore();
  const mixed = await snapshot(root);
  assert.notEqual(mixed[0], before[0]);
  assert.deepEqual(mixed.slice(1), before.slice(1));
  assert.equal((await fs.readdir(path.join(root, 'shared'))).some(n => n.endsWith('.tmp')), false);
  await assert.rejects(run({ projectRoot: root, mode: 'check' }), { code: 'RUNTIME_STALE' });
  assert.deepEqual(await snapshot(root), mixed);
  await run({ projectRoot: root, mode: 'write' });
  await run({ projectRoot: root, mode: 'check' });
});
