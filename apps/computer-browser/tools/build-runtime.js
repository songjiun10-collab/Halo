'use strict';

// Developer-only compiler boundary. Browser execution never imports this tool.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Each cohort is one compiler project with a fixed root and an exact output set.
const COHORTS = Object.freeze([
  Object.freeze({ config: 'tsconfig.runtime.json', source: 'runtime-src/shared', output: 'shared',
    names: Object.freeze(['harness-contracts', 'task-profile-contracts', 'harness-profile', 'capability-registry']) }),
  Object.freeze({ config: 'tsconfig.runtime-harness.json', source: 'runtime-src/main/harness', output: 'main/harness',
    names: Object.freeze(['generic-mcp-broker', 'mcp-schema-validator', 'mcp-schema-worker']) }),
]);
const ARTIFACTS = COHORTS.flatMap(cohort => cohort.names.map(name => ({ cohort, name })));
const LOCK = '.runtime-build.lock';

function failure(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}
async function safePath(target, kind, missing = false) {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (missing && i === parts.length - 1 && error.code === 'ENOENT') return null;
      throw failure('RUNTIME_PATH', `missing path ${current}`);
    }
    if (stat.isSymbolicLink()) throw failure('RUNTIME_PATH', `symlink ${current}`);
    if (i < parts.length - 1 ? !stat.isDirectory() : kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
      throw failure('RUNTIME_PATH', `unexpected file kind ${current}`);
    }
  }
  return fs.lstat(absolute);
}
async function readSafe(target) {
  await safePath(target, 'file');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
async function fingerprint(root) {
  const paths = COHORTS.flatMap(c => [c.config, ...c.names.map(n => `${c.source}/${n}.ts`)]);
  const hash = crypto.createHash('sha256');
  for (const relative of paths) { hash.update(relative); hash.update(await readSafe(path.join(root, relative))); }
  return hash.digest('hex');
}
async function validateConfig(root, cohort) {
  const config = JSON.parse((await readSafe(path.join(root, cohort.config))).toString('utf8'));
  const expected = cohort.names.map(n => `${cohort.source}/${n}.ts`);
  const options = config.compilerOptions;
  const permitted = new Set(['strict', 'noEmitOnError', 'allowJs', 'skipLibCheck', 'target', 'module',
    'moduleResolution', 'ignoreDeprecations', 'types', 'typeRoots', 'rootDir', 'newLine', 'removeComments',
    'declaration', 'sourceMap', 'incremental', 'importHelpers']);
  if (Object.keys(config).some(k => !['compilerOptions', 'files'].includes(k)) || !options ||
      Object.keys(options).some(k => !permitted.has(k)) || JSON.stringify(config.files) !== JSON.stringify(expected) ||
      options.strict !== true || options.noEmitOnError !== true || options.allowJs !== false ||
      options.target !== 'ES2022' || options.module !== 'CommonJS' || options.rootDir !== cohort.source ||
      options.newLine !== 'lf' || options.removeComments !== false || options.declaration !== false ||
      options.sourceMap !== false || options.incremental !== false || options.importHelpers !== false ||
      (options.typeRoots !== undefined && JSON.stringify(options.typeRoots) !== '["./node_modules/@types"]') ||
      !Array.isArray(options.types) || options.types.some(t => t !== 'node')) {
    throw failure('RUNTIME_CONFIG', 'unsupported compiler configuration');
  }
}
async function compile(root, cohort, temporary) {
  const compiler = path.join(root, 'node_modules/typescript/lib/tsc.js');
  await safePath(compiler, 'file');
  const metadata = JSON.parse((await readSafe(path.join(root, 'node_modules/typescript/package.json'))).toString('utf8'));
  if (metadata.version !== '6.0.2') throw failure('RUNTIME_COMPILER', 'TypeScript 6.0.2 required');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [compiler, '-p', path.join(root, cohort.config), '--outDir', temporary],
      { cwd: root, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
    const timer = setTimeout(() => { child.kill(); reject(failure('RUNTIME_COMPILE', 'compiler timeout')); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(failure('RUNTIME_COMPILE', 'compiler launch failed')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(failure('RUNTIME_COMPILE', 'typecheck or emit failed; run npm run typecheck for diagnostics')); });
  });
}
async function runRuntimeBuild({ projectRoot, mode }) {
  if (typeof projectRoot !== 'string' || !['check', 'write'].includes(mode)) throw failure('RUNTIME_ARGUMENT', 'invalid build request');
  const root = path.resolve(projectRoot);
  await safePath(root, 'directory');
  for (const cohort of COHORTS) await safePath(path.join(root, cohort.output), 'directory');
  const destinations = ARTIFACTS.map(({ cohort, name }) => path.join(root, `${cohort.output}/${name}.js`));
  for (const destination of destinations) await safePath(destination, 'file', true);
  let lockHandle;
  let lockStat;
  const temporaries = [];
  const siblings = new Set();
  try {
    if (mode === 'write') {
      try { lockHandle = await fs.open(path.join(root, LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw failure('RUNTIME_LOCKED', 'another publisher or stale crash lock; inspect before manual recovery'); throw error; }
      lockStat = await lockHandle.stat();
      await lockHandle.writeFile(JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }));
    }
    const before = await fingerprint(root);
    for (const cohort of COHORTS) await validateConfig(root, cohort);
    const tempRoot = await fs.realpath(os.tmpdir());
    const bytes = [];
    for (const cohort of COHORTS) {
      const temporary = await fs.mkdtemp(path.join(tempRoot, 'halo-runtime-'));
      temporaries.push(temporary);
      await fs.chmod(temporary, 0o700);
      await compile(root, cohort, temporary);
      if (await fingerprint(root) !== before) throw failure('RUNTIME_CHANGED', 'source/config changed during compilation');
      const emitted = (await fs.readdir(temporary)).sort();
      if (JSON.stringify(emitted) !== JSON.stringify(cohort.names.map(n => `${n}.js`).sort())) throw failure('RUNTIME_OUTPUT', 'unexpected compiler output set');
      for (const name of cohort.names) {
        bytes.push(Buffer.concat([Buffer.from(`// Generated from ${cohort.source}/${name}.ts. Do not edit; run npm run build:runtime.\n`), await readSafe(path.join(temporary, `${name}.js`))]));
      }
    }
    // Validate the whole destination cohort before comparing any bytes: missing wins over stale.
    const states = [];
    for (const destination of destinations) states.push(await safePath(destination, 'file', true));
    if (mode === 'check') {
      const missing = states.findIndex(s => s === null);
      if (missing >= 0) throw failure('RUNTIME_MISSING', destinations[missing]);
      for (let i = 0; i < destinations.length; i += 1) {
        if (!(await readSafe(destinations[i])).equals(bytes[i])) throw failure('RUNTIME_STALE', destinations[i]);
      }
    } else {
      for (let i = 0; i < destinations.length; i += 1) {
        const sibling = `${destinations[i]}.${crypto.randomUUID()}.tmp`;
        const handle = await fs.open(sibling, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        siblings.add(sibling);
        try { await handle.writeFile(bytes[i]); } finally { await handle.close(); }
        const outputMode = states[i] ? states[i].mode & 0o777 : 0o644;
        await fs.chmod(sibling, outputMode);
      }
      if (await fingerprint(root) !== before) throw failure('RUNTIME_CHANGED', 'source/config changed before publication');
      let i = 0;
      for (const sibling of siblings) {
        await safePath(destinations[i], 'file', true);
        await fs.rename(sibling, destinations[i]);
        i += 1;
      }
    }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('RUNTIME_')) throw error;
    throw failure('RUNTIME_IO', 'runtime filesystem operation failed');
  } finally {
    for (const sibling of siblings) await fs.unlink(sibling).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const temporary of temporaries) await fs.rm(temporary, { recursive: true, force: true });
    if (lockHandle) {
      await lockHandle.close();
      const lockPath = path.join(root, LOCK);
      const current = await fs.lstat(lockPath).catch(() => null);
      if (current && current.dev === lockStat.dev && current.ino === lockStat.ino && !current.isSymbolicLink()) await fs.unlink(lockPath);
    }
  }
}

module.exports = { runRuntimeBuild };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('RUNTIME_ARGUMENT: only --check is supported'); process.exitCode = 1;
  } else {
    runRuntimeBuild({ projectRoot: path.resolve(__dirname, '..'), mode: args[0] === '--check' ? 'check' : 'write' })
      .catch(error => { console.error(error.code?.startsWith('RUNTIME_') ? error.message : 'RUNTIME_IO: build failed'); process.exitCode = 1; });
  }
}
