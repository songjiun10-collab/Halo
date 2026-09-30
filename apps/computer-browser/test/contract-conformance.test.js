"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const harness = require("../shared/harness-contracts");
const routine = require("../shared/routine-contracts");
const schedule = require("../shared/schedule-contracts");

const DIR = path.join(__dirname, "..", "contracts", "conformance");

// kind -> reference validator. A port in another language must pass the same files.
const VALIDATORS = {
  goal_spec: (value) => harness.validateGoalSpec(value),
  journal_event: (value) => harness.validateJournalEvent(value),
  checkpoint_envelope: (value) => harness.validateCheckpointEnvelope(value),
  evidence: (value) => harness.validateEvidence(value),
  proposal_envelope: (value) => harness.validateProposalEnvelope(value),
  message_envelope: (value) => harness.validateMessageEnvelope(value),
  routine_definition: (value) => routine.validateRoutineDefinition(value),
  schedule_input: (value) => schedule.validateScheduleInput(value),
  schedule_record: (value) => schedule.validateScheduleRecord(value),
};

// `pad` lets a case describe an oversized string without storing it:
// { path: "payload.blob", char: "x", length: 2200000 } sets that path to char repeated length times.
function applyPad(value, pad) {
  if (!pad) return value;
  const parts = pad.path.split(".");
  let node = value;
  for (const part of parts.slice(0, -1)) node = node[part];
  node[parts[parts.length - 1]] = pad.char.repeat(pad.length);
  return value;
}

function load(kind) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${kind}.json`), "utf8"));
}

test("every contract kind has a corpus file with valid and invalid cases", () => {
  for (const kind of Object.keys(VALIDATORS)) {
    const corpus = load(kind);
    assert.equal(corpus.kind, kind);
    assert.ok(corpus.cases.length >= 2, `${kind} needs cases`);
    assert.ok(corpus.cases.some((c) => c.valid === true), `${kind} needs a valid case`);
    assert.ok(corpus.cases.some((c) => c.valid === false), `${kind} needs an invalid case`);
    const names = corpus.cases.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `${kind} case names must be unique`);
  }
});

for (const kind of Object.keys(VALIDATORS)) {
  test(`conformance: ${kind}`, () => {
    for (const c of load(kind).cases) {
      let error = null;
      try {
        VALIDATORS[kind](applyPad(structuredClone(c.value), c.pad));
      } catch (e) {
        error = e;
      }
      if (c.valid) {
        assert.equal(error, null, `${kind}/${c.name} should be valid but threw ${error?.code}: ${error?.message}`);
      } else {
        assert.ok(error, `${kind}/${c.name} should be rejected`);
        assert.equal(typeof c.code, "string", `${kind}/${c.name} must record an expected code`);
        assert.equal(error.code, c.code, `${kind}/${c.name} wrong code: ${error.message}`);
      }
    }
  });
}

test("conformance: schedule_evaluate", () => {
  const corpus = load("schedule_evaluate");
  assert.equal(corpus.kind, "schedule_evaluate");
  assert.ok(corpus.cases.length >= 8);
  const actions = new Set();
  for (const c of corpus.cases) {
    const decision = schedule.evaluateSchedule(c.input.record, c.input.nowMs);
    assert.deepEqual(decision, c.expected, `schedule_evaluate/${c.name}`);
    actions.add(decision.action);
  }
  for (const action of ["run", "none", "missed", "finished"]) assert.ok(actions.has(action), `corpus lacks a "${action}" case`);
});

test("conformance: corpus files are plain JSON with no undefined/NaN leaks", () => {
  for (const file of fs.readdirSync(DIR).filter((name) => name.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(DIR, file), "utf8");
    assert.equal(JSON.stringify(JSON.parse(text)).length > 2, true, file);
  }
});
