"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { windowDecision, clickDecision, typeDecision, keyDecision, isProtected } = require("../main/harness/os-policy");

const notes = { bundleId: "com.apple.Notes", app: "Notes", title: "Shopping" };
const allow = { allowedApps: ["com.apple.Notes"] };
const control = (role, name, extra = {}) => ({ role, name, x: 0.5, y: 0.5, w: 0.1, h: 0.05, ...extra });

test("with no allowed app nothing is allowed, and an unlisted app is refused", () => {
  assert.equal(windowDecision(notes, { allowedApps: [] }).gate, "deny");
  assert.equal(windowDecision({ bundleId: "com.example.Other" }, allow).gate, "deny");
  assert.equal(windowDecision(notes, allow).gate, "auto");
  assert.equal(windowDecision({}, allow).gate, "deny");
});

test("protected apps are refused even when listed, and a title cannot pass for a bundle", () => {
  for (const id of ["com.apple.keychainaccess", "com.apple.systempreferences", "com.apple.Terminal", "com.halo.agent", "com.apple.preferences.x"]) {
    assert.equal(isProtected(id), true, id);
    assert.equal(windowDecision({ bundleId: id }, { allowedApps: [id] }).gate, "deny", id);
  }
  assert.equal(windowDecision({ bundleId: "com.example.Other", title: "Notes", app: "Notes" }, allow).gate, "deny");
});

test("clicks follow the effect classifier; secure, covered and unknown controls do not pass automatically", () => {
  assert.equal(clickDecision(notes, control("link", "Open folder"), allow).gate, "auto");
  assert.equal(clickDecision(notes, control("button", "Delete note"), allow).gate, "ask");
  assert.equal(clickDecision(notes, control("button", "Delete my account"), allow).gate, "deny");
  assert.equal(clickDecision(notes, control("textbox", "Body", { secure: true }), allow).gate, "deny");
  assert.equal(clickDecision(notes, control("link", "Open", { covered: true }), allow).gate, "ask");
  assert.equal(clickDecision(notes, null, allow).gate, "ask");
  assert.equal(clickDecision({ bundleId: "com.example.Other" }, control("link", "Open"), allow).gate, "deny");
});

test("typing goes only into a text field that is not secure", () => {
  assert.equal(typeDecision(notes, control("textbox", "Body"), allow).gate, "auto");
  assert.equal(typeDecision(notes, control("textbox", "Password", { secure: true }), allow).gate, "deny");
  assert.equal(typeDecision(notes, control("button", "OK"), allow).gate, "ask");
  assert.equal(typeDecision(notes, null, allow).gate, "ask");
});

test("keys: movement passes, Enter and modifier shortcuts wait, junk is refused", () => {
  assert.equal(keyDecision(notes, "ArrowDown", allow).gate, "auto");
  assert.equal(keyDecision(notes, "Enter", allow).gate, "ask");
  assert.equal(keyDecision(notes, "Cmd+W", allow).gate, "ask");
  assert.equal(keyDecision(notes, "", allow).gate, "deny");
  assert.equal(keyDecision(notes, 5, allow).gate, "deny");
});

test("the per-task OS action limit stops further actions", () => {
  assert.equal(windowDecision(notes, { ...allow, maxActions: 3, actionsUsed: 2 }).gate, "auto");
  assert.equal(windowDecision(notes, { ...allow, maxActions: 3, actionsUsed: 3 }).gate, "deny");
});
