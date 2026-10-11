"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateActionPolicy, PERMISSION_MODES } = require("../main/harness/permission-policy");

test("permission policy applies the four-mode action matrix", () => {
  const expected = {
    observe: {
      observe: "allow", scroll: "allow", find: "allow", zoom: "allow", select_all: "allow", copy: "deny", navigate: "deny", follow_link: "deny",
      click: "deny", type: "deny", submit_form: "deny", download: "deny", evaluate: "deny",
    },
    browse: {
      observe: "allow", scroll: "allow", find: "allow", zoom: "allow", select_all: "allow", copy: "deny", navigate: "allow", follow_link: "allow",
      click: "deny", type: "deny", submit_form: "deny", download: "deny", evaluate: "deny",
    },
    interact: {
      observe: "allow", scroll: "allow", find: "allow", zoom: "allow", select_all: "allow", copy: "human_review", navigate: "allow", follow_link: "allow",
      click: "human_review", type: "human_review", submit_form: "deny", download: "deny", evaluate: "human_review",
    },
    full: {
      observe: "allow", scroll: "allow", find: "allow", zoom: "allow", select_all: "allow", copy: "allow", navigate: "allow", follow_link: "allow",
      click: "allow", type: "allow", submit_form: "allow", download: "deny", evaluate: "allow",
    },
  };

  for (const mode of PERMISSION_MODES) {
    for (const [action, outcome] of Object.entries(expected[mode])) {
      assert.equal(evaluateActionPolicy(mode, action).outcome, outcome, `${mode}/${action}`);
    }
  }
});

test("permission policy rejects unknown mode and action values", () => {
  assert.throws(() => evaluateActionPolicy("unrestricted", "click"), { code: "invalid_permission_mode" });
  assert.throws(() => evaluateActionPolicy("browse", "execute_javascript"), { code: "unknown_action" });
});

test("full mode marks explicit approver bypass while browse retains independent review", () => {
  assert.equal(evaluateActionPolicy("full", "submit_form").approval, "bypass");
  assert.equal(evaluateActionPolicy("browse", "navigate").approval, "approver");
  assert.equal(evaluateActionPolicy("interact", "type").approval, "human");
});
