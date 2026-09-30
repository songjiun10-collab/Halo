"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const MODULE_NAMES = ["harness-contracts", "task-profile-contracts", "harness-profile", "capability-registry"];

// Captured from the reviewed phase-one CommonJS interface at c2ea9fc. These
// literals catch export = / named-export changes without deriving the expected
// interface from either the TS source or the generated modules under test.
const EXPORT_KEYS = {
  "harness-contracts": [
    "SCHEMA_VERSION", "UUID_RE", "ID_RE", "MAX_ORIGINAL_REQUEST_BYTES",
    "MAX_AMENDMENT_TEXT_BYTES", "MAX_CRITERIA_COUNT", "MAX_CRITERION_TEXT_CHARS",
    "MAX_CONSTRAINT_TEXT_CHARS", "MAX_EVENT_BYTES", "MAX_CHECKPOINT_BYTES",
    "MAX_TASK_STORE_BYTES", "MAX_CONTEXT_PACKET_BYTES", "MAX_RECENT_EVENTS_IN_CONTEXT",
    "MAX_ACTIONS_PER_PROPOSAL", "MAX_ACTIONS_PER_PROPOSAL_SHORT", "MAX_CHILD_ASSIGNMENTS",
    "MAX_CHILD_SUBGOAL_BYTES", "MAX_ENTRY_URL_CHARS", "MEMORY_POLICIES", "MESSAGE_KINDS",
    "MAX_MESSAGE_TEXT_BYTES", "MAX_IDEMPOTENCY_KEY_CHARS", "MAX_MESSAGE_EVIDENCE_REFS",
    "MAX_HANDOFF_FIELD_CHARS", "MAX_HANDOFF_LIST_ITEMS", "MAX_MESSAGES_PER_TURN",
    "MAX_MESSAGE_TURN_CONTEXT_BYTES", "MAX_PENDING_MESSAGES_PER_CONVERSATION",
    "MAX_UNOBSERVED_STEER_PER_CHILD", "MAX_STEER_PER_CHILD_PER_WINDOW",
    "STEER_RATE_WINDOW_MS", "MAX_MESSAGE_PREVIEW_CHARS", "SEND_MESSAGE_FIELDS",
    "MESSAGE_ENVELOPE_FIELDS", "MESSAGE_TURN_CONSUMED_FIELDS", "MAX_PLANNER_FRAME_BYTES",
    "PLANNER_RESPONSE_TIMEOUT_MS", "APPROVAL_EXPIRY_MS", "SEGMENT_ROTATION_CALLS",
    "NO_PROGRESS_REPLAN_THRESHOLD", "DEFAULT_LIMITS", "DEFAULT_CRITERION_C1", "EVENT_TYPES",
    "VERIFICATION_KINDS", "EVIDENCE_KINDS", "EVIDENCE_VERIFICATION_STATES", "PROPOSAL_KINDS",
    "ContractError", "isPlainObject", "assertUuid", "assertId", "normalizeGoalSpec",
    "validateGoalSpec", "validateGoalTrigger", "applyAmendment", "validateJournalEvent",
    "validateCheckpointEnvelope", "validateEvidence", "validateProposalEnvelope",
    "validateChildAssignment", "validateHandoff", "validateMessageContent",
    "validateMessageEnvelope", "deriveOrigin", "MCP_CALL_ACTION_TYPE", "MAX_MCP_ARGUMENT_BYTES",
    "MCP_CALL_OUTCOMES", "validateMcpProposal", "validateMcpCallNote",
  ],
  "task-profile-contracts": [
    "PROFILE_SCHEMA_VERSION", "SOURCE_IDS", "validateResolvedTaskProfile",
    "validateTaskProfileSelectedPayload", "validateWorkGoalBinding",
    "validateProfileRequiredGoalCreatedPayload",
  ],
  "harness-profile": [
    "HARNESS_PROFILES", "HarnessProfileError", "validateHarnessProfile",
    "selectHarnessProfile", "maxActionsPerProposal",
  ],
  "capability-registry": ["CAPABILITY_IDS", "CAPABILITY_REGISTRY_VERSION", "getCapabilityProfile"],
};

// Run this function in a fresh Node process: deleting selected require.cache
// entries in the parent would leave other consumers holding cached exports.
function exerciseFreshCycle(directory, order) {
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const modulePath = (name) => path.join(directory, `${name}.js`);
  const first = require(modulePath(order[0]));
  if (order[0] === "harness-contracts") {
    assert.equal(
      require.cache[require.resolve(modulePath("task-profile-contracts"))],
      undefined,
      "loading harness-contracts must not eagerly load the profile contract",
    );
  }
  const second = require(modulePath(order[1]));
  assert.equal(require(modulePath(order[0])), first, "the first export object must retain its identity");
  assert.equal(require(modulePath(order[1])), second, "the second export object must retain its identity");

  const harness = require(modulePath("harness-contracts"));
  const profiles = require(modulePath("task-profile-contracts"));
  const selected = {
    profileSchemaVersion: 1,
    classifierVersion: "task-profile-router-v1",
    duration: {
      id: "middle",
      harnessProfileVersion: 1,
      policySetId: "goal-limits-v1",
      effectiveLimits: { maxActions: 1000, maxPlannerCalls: 500, maxActiveMs: 14400000 },
    },
    capability: {
      id: "browser",
      registryVersion: 1,
      dependencies: ["browser"],
      adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }],
    },
    selection: { duration: { source: "default" }, capability: { source: "default" } },
  };
  const journal = (type, payload) => ({
    seq: 1,
    eventId: "22222222-2222-4222-8222-222222222222",
    taskId: "11111111-1111-4111-8111-111111111111",
    goalVersion: 1,
    type,
    payload,
    at: "2026-10-01T00:00:00.000Z",
  });

  assert.equal(profiles.validateTaskProfileSelectedPayload(selected), selected);
  const selectedEvent = journal("task_profile_selected", selected);
  assert.equal(harness.validateJournalEvent(selectedEvent), selectedEvent);
  const createdEvent = journal("goal_created", { goalVersion: 1, profileRequired: true });
  assert.equal(harness.validateJournalEvent(createdEvent), createdEvent);

  // A hoisted cyclic import can leave the profile module with an undefined
  // ContractError constructor: checking real rejections detects that failure.
  const invalidSelected = structuredClone(selected);
  invalidSelected.selection.capability.source = "model";
  assert.throws(() => harness.validateJournalEvent(journal("task_profile_selected", invalidSelected)), (error) => {
    assert.ok(error instanceof harness.ContractError);
    assert.equal(error.code, "unknown_enum");
    return true;
  });
  assert.throws(() => harness.validateJournalEvent(journal("goal_created", { goalVersion: 1, profileRequired: false })), (error) => {
    assert.ok(error instanceof harness.ContractError);
    assert.equal(error.code, "invalid_field");
    return true;
  });

  // Preserve the malformed-JSON rejection whose TypeError has no code. A
  // migration must not normalize it to another code or emit a new Error field.
  const malformed = structuredClone(selected);
  malformed.capability.dependencies = [{ toString: null }];
  assert.throws(() => harness.validateJournalEvent(journal("task_profile_selected", malformed)), (error) => {
    assert.ok(error instanceof harness.ContractError);
    assert.deepEqual(Object.keys(error), ["name", "code"]);
    assert.equal(error.code, undefined);
    assert.equal(JSON.stringify(error), '{"name":"ContractError"}');
    return true;
  });
  process.stdout.write("compatible\n");
}

function conformanceCases(directory) {
  const cases = MODULE_NAMES.map((name) => [
    `${name} preserves export keys/order without __esModule`,
    () => {
      const exports = require(path.join(directory, `${name}.js`));
      assert.deepEqual(Object.keys(exports), EXPORT_KEYS[name]);
      assert.equal(Object.hasOwn(exports, "__esModule"), false);
    },
  ]);

  for (const [moduleName, className] of [
    ["harness-contracts", "ContractError"],
    ["harness-profile", "HarnessProfileError"],
  ]) {
    cases.push([`${className} preserves Error own-key order and JSON serialization`, () => {
      const ErrorType = require(path.join(directory, `${moduleName}.js`))[className];
      for (const code of ["invalid_field", undefined]) {
        const error = new ErrorType(code, "rejected input");
        assert.ok(error instanceof Error);
        assert.equal(Object.getPrototypeOf(error), ErrorType.prototype);
        assert.equal(error.message, "rejected input");
        assert.equal(error.name, className);
        assert.equal(error.code, code);
        assert.deepEqual(Object.getOwnPropertyNames(error), ["stack", "message", "name", "code"]);
        assert.deepEqual(Object.keys(error), ["name", "code"]);
        assert.equal(JSON.stringify(error), code === undefined
          ? `{"name":"${className}"}`
          : `{"name":"${className}","code":"invalid_field"}`);
      }
    }]);
  }

  for (const order of [
    ["harness-contracts", "task-profile-contracts"],
    ["task-profile-contracts", "harness-contracts"],
  ]) {
    cases.push([`${order.join(" then ")} preserves lazy journal validation in a fresh process`, () => {
      const script = `(${exerciseFreshCycle.toString()})(...JSON.parse(process.argv[1]));`;
      const result = spawnSync(process.execPath, ["-e", script, JSON.stringify([directory, order])], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout, "compatible\n");
      assert.equal(result.stderr, "", "fresh module loading must not produce circular-dependency warnings");
    }]);
  }
  return cases;
}

for (const [name, run] of conformanceCases(path.join(APP_ROOT, "shared"))) {
  test(`checked-in runtime: ${name}`, run);
}

test("TypeScript sources compile to exactly four disposable CommonJS artifacts with the same runtime contracts", async (t) => {
  for (const name of MODULE_NAMES) {
    const source = path.join(APP_ROOT, "runtime-src", "shared", `${name}.ts`);
    assert.ok(fs.existsSync(source), `missing TypeScript source: runtime-src/shared/${name}.ts`);
  }

  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "halo-runtime-conformance-"));
  fs.chmodSync(outputDirectory, 0o700);
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    require.resolve("typescript/bin/tsc"),
    "--project", path.join(APP_ROOT, "tsconfig.runtime.json"),
    "--outDir", outputDirectory,
    "--pretty", "false",
  ], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.deepEqual(fs.readdirSync(outputDirectory).sort(), MODULE_NAMES.map((name) => `${name}.js`).sort());

  for (const [name, run] of conformanceCases(outputDirectory)) {
    await t.test(`compiled runtime: ${name}`, run);
  }
});
