"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const APP_ROOT = path.resolve(__dirname, "..");
const HARNESS_NAMES = ["generic-mcp-broker", "mcp-schema-validator", "mcp-schema-worker", "message-port", "message-mailbox"];

test("harness modules are generated from TypeScript sources", () => {
  for (const name of HARNESS_NAMES) {
    assert.ok(fs.existsSync(path.join(APP_ROOT, "runtime-src/main/harness", `${name}.ts`)),
      `missing TypeScript source: runtime-src/main/harness/${name}.ts`);
    const output = fs.readFileSync(path.join(APP_ROOT, "main/harness", `${name}.js`), "utf8");
    assert.ok(output.startsWith(`// Generated from runtime-src/main/harness/${name}.ts. Do not edit; run npm run build:runtime.\n"use strict";\n`),
      `main/harness/${name}.js is not a generated artifact`);
  }
});

test("generated harness modules keep their exact CommonJS export surface", () => {
  const broker = require("../main/harness/generic-mcp-broker");
  assert.deepEqual(Object.keys(broker), ["GenericMcpBroker", "McpBrokerError"]);
  assert.deepEqual(Object.keys(require("../main/harness/mcp-schema-validator")), ["validateMcpArguments"]);
  const error = new broker.McpBrokerError("busy");
  assert.ok(error instanceof Error);
  assert.deepEqual([error.code, error.message], ["busy", "MCP broker: busy"]);
  assert.deepEqual(Object.keys(error), ["code"]);
});

test("harness TypeScript sources compile to exactly five CommonJS artifacts", (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "halo-harness-conformance-"));
  fs.chmodSync(outputDirectory, 0o700);
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    require.resolve("typescript/bin/tsc"),
    "--project", path.join(APP_ROOT, "tsconfig.runtime-harness.json"),
    "--outDir", outputDirectory,
    "--pretty", "false",
  ], { cwd: APP_ROOT, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.deepEqual(fs.readdirSync(outputDirectory).sort(), HARNESS_NAMES.map((name) => `${name}.js`).sort());
  for (const name of HARNESS_NAMES) {
    assert.doesNotMatch(fs.readFileSync(path.join(outputDirectory, `${name}.js`), "utf8"), /__esModule/);
  }
});
