'use strict';

// Shared fixture for runtime build tests: a project root with all compiler
// cohorts, the real pinned compiler and stale checked-in artifacts.
const fs = require('node:fs/promises');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const sharedNames = ['harness-contracts', 'task-profile-contracts', 'harness-profile', 'capability-registry', 'task-profile-router', 'port-contracts', 'layout-constants', 'clamp-bounds'];
const harnessNames = ['generic-mcp-broker', 'mcp-schema-validator', 'mcp-schema-worker', 'message-port', 'message-mailbox', 'background-runtime-ui', 'background-launch-agent', 'recovery-policy', 'model-tiers', 'context-builder', 'nvidia-model-catalog', 'screen-map', 'effect-classifier', 'planner-escalation', 'planner-routing', 'slack-task-entry', 'activity-journal', 'strategy-learning', 'strategy-learning-store', 'cdp-web-contents', 'cdp-browser-host', 'cdp-engine', 'renderer-lifecycle', 'chromium-bridge', 'chromium-keychain', 'session-vault', 'chromium-session', 'chromium-desktop', 'browser-input', 'effect-verifier', 'halowright-locator', 'halowright', 'frame-capture', 'computer-use-observation', 'turn-memory-preparation', 'private-network', 'os-policy', 'card-blind', 'capability-lease', 'permission-policy', 'action-gate', 'research-sources', 'action-safety', 'payment-mandate'];
const cohorts = [
  { config: 'tsconfig.runtime.json', source: 'runtime-src/shared', output: 'shared', names: sharedNames },
  { config: 'tsconfig.runtime-harness.json', source: 'runtime-src/main/harness', output: 'main/harness', names: harnessNames },
  { config: 'tsconfig.runtime-integration.json', source: 'runtime-src/integration', output: 'integration', names: ['approval-latency'] },
];

async function writeRuntimeFixture(root) {
  // Copy the real compiler, not a fake compiler or symlinked dependency.
  await fs.cp(path.join(packageRoot, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), { recursive: true });
  for (const cohort of cohorts) {
    await fs.mkdir(path.join(root, cohort.source), { recursive: true });
    await fs.mkdir(path.join(root, cohort.output), { recursive: true });
    await fs.writeFile(path.join(root, cohort.config), JSON.stringify({
      compilerOptions: { strict: true, noEmitOnError: true, allowJs: false, target: 'ES2022', module: 'CommonJS',
        rootDir: cohort.source, newLine: 'lf', types: [], declaration: false, sourceMap: false,
        incremental: false, importHelpers: false, removeComments: false },
      files: cohort.names.map(name => `${cohort.source}/${name}.ts`),
    }));
    for (const name of cohort.names) {
      await fs.writeFile(path.join(root, `${cohort.source}/${name}.ts`), `const value: string = "${name}";\nexport = { value };\n`);
      await fs.writeFile(path.join(root, `${cohort.output}/${name}.js`), `old ${name}\n`);
    }
  }
}

module.exports = { harnessNames, sharedNames, writeRuntimeFixture };
