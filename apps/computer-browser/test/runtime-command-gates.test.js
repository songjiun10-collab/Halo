'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const names = ['harness-contracts', 'task-profile-contracts', 'harness-profile', 'capability-registry'];

test('stale runtime artifacts block build, test and launches before downstream work', async t => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'halo-runtime-commands-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const browserRoot = path.join(temporary, 'apps/computer-browser');
  const frontendRoot = path.join(temporary, 'frontend');
  await fs.mkdir(path.join(browserRoot, 'runtime-src/shared'), { recursive: true });
  await fs.mkdir(path.join(browserRoot, 'shared'));
  await fs.mkdir(path.join(browserRoot, 'tools'));
  await fs.mkdir(path.join(browserRoot, 'test'));
  await fs.mkdir(frontendRoot);
  await fs.cp(path.join(packageRoot, 'node_modules/typescript'), path.join(browserRoot, 'node_modules/typescript'), { recursive: true });
  await fs.copyFile(path.join(packageRoot, 'tools/build-runtime.js'), path.join(browserRoot, 'tools/build-runtime.js'));
  await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(browserRoot, 'package.json'));
  const config = {
    compilerOptions: { strict: true, noEmitOnError: true, allowJs: false, target: 'ES2022', module: 'CommonJS',
      rootDir: 'runtime-src/shared', newLine: 'lf', types: [], declaration: false, sourceMap: false,
      incremental: false, importHelpers: false, removeComments: false },
    files: names.map(name => `runtime-src/shared/${name}.ts`),
  };
  await fs.writeFile(path.join(browserRoot, 'tsconfig.runtime.json'), JSON.stringify(config));
  for (const name of names) {
    await fs.writeFile(path.join(browserRoot, `runtime-src/shared/${name}.ts`), `export = { value: '${name}' };\n`);
    await fs.writeFile(path.join(browserRoot, `shared/${name}.js`), `stale ${name}\n`);
  }
  const initialArtifacts = await Promise.all(names.map(name => fs.readFile(path.join(browserRoot, `shared/${name}.js`))));
  await fs.writeFile(path.join(frontendRoot, 'package.json'), JSON.stringify({
    name: 'downstream-frontend', private: true,
    scripts: { build: 'node -e "require(\'node:fs\').writeFileSync(\'frontend-ran\', \'yes\')"' },
  }));
  await fs.writeFile(path.join(browserRoot, 'test/downstream.test.js'),
    "require('node:fs').writeFileSync('node-test-ran', 'yes');\n");

  for (const command of ['build', 'test', 'start', 'test:renderer:e2e']) {
    const args = command === 'test' ? ['test'] : ['run', command];
    const run = spawnSync('npm', args, { cwd: browserRoot, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, npm_config_update_notifier: 'false' } });
    assert.equal(run.error, undefined, `${command}: ${run.error?.message}`);
    assert.notEqual(run.status, 0, `${command} unexpectedly succeeded`);
    assert.match(`${run.stdout}\n${run.stderr}`, /RUNTIME_STALE/, `${command} did not fail at the real runtime gate`);
    await assert.rejects(fs.stat(path.join(frontendRoot, 'frontend-ran')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(browserRoot, 'node-test-ran')), { code: 'ENOENT' });
    const artifacts = await Promise.all(names.map(name => fs.readFile(path.join(browserRoot, `shared/${name}.js`))));
    assert.deepEqual(artifacts, initialArtifacts, `${command} modified a checked-in artifact`);
  }
});
