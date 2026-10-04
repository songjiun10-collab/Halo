"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateMcpArguments } = require("../main/harness/mcp-schema-validator");
const schema = { type: "object", properties: { name: { type: "string" }, count: { type: "integer", minimum: 1 } }, required: ["name"], additionalProperties: false };
// The deadline also covers cold worker spawn, so semantic checks use the
// largest caller budget the validator accepts; the 500ms default is unchanged.
const SEMANTIC = { timeoutMs: 1000 };
test("validates MCP arguments without coercion, defaults or removed fields", async () => {
  assert.equal(await validateMcpArguments(schema, { name: "hello", count: 1 }, SEMANTIC), true);
  for (const value of [{ count: 1 }, { name: 5 }, { name: "hello", count: "1" }, { name: "hello", extra: true }]) {
    const before = JSON.stringify(value);
    assert.equal(await validateMcpArguments(schema, value, SEMANTIC), false);
    assert.equal(JSON.stringify(value), before);
  }
});
test("unsupported remote refs, oversized or cyclic schemas fail closed", async () => {
  assert.equal(await validateMcpArguments({ $ref: "https://example.test/schema" }, {}), false);
  assert.equal(await validateMcpArguments({ type: "object", description: "x".repeat(17000) }, {}), false);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(await validateMcpArguments(cyclic, {}), false);
});
test("schema validation cancellation returns false and does not keep a worker alive", async () => {
  const controller = new AbortController(); controller.abort();
  assert.equal(await validateMcpArguments(schema, { name: "hello" }, { signal: controller.signal }), false);
});
test("expensive untrusted regular expressions have a bounded worker deadline", async () => {
  const started = Date.now();
  assert.equal(await validateMcpArguments({ type: "string", pattern: "^(a+)+$" }, "a".repeat(100) + "!", { timeoutMs: 150 }), false);
  assert.ok(Date.now() - started < 2000);
});
