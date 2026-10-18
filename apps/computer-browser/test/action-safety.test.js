"use strict";
// Every action type the agent can propose must say how the three host safety checks treat it.
// A new action type with no declaration fails here, so it cannot silently skip a check;
// a declared "applies" is proven by a crafted action that really triggers the check, and a
// declared "not-applicable" is proven by the check really returning nothing.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ACTIONS } = require("../main/harness/permission-policy");
const { inspectAction, SAFETY_DECLARATIONS, CHECKS } = require("../main/harness/action-safety");

const observation = {
  id: "obs1", url: "https://shop.example/checkout", documentEpoch: 1,
  elements: [
    { elementId: "pay", role: "button", name: "Place order" },
    { elementId: "pw", role: "textbox", name: "Password", inputType: "password" },
    { elementId: "card", role: "textbox", name: "Card number", cardField: true },
    { elementId: "note", role: "textbox", name: "Gift note" },
    { elementId: "more", role: "link", name: "Cart", href: "https://shop.example/cart" },
  ],
};
const targets = [
  { x: 0, y: 0, w: 10, h: 10, role: "button", name: "Place order" },
  { x: 20, y: 0, w: 10, h: 10, role: "button", name: "Delete account" },
  { x: 40, y: 0, w: 10, h: 10, role: "textbox", name: "Card number", cardField: true },
];
const ctx = { observation, screenTargets: { observationId: "obs1", targets }, computerUse: true, userText: "buy it" };

// A crafted action per (type, check) that exercises the check; null where the declaration says not-applicable.
const CRAFTED = {
  observe: { type: "observe" },
  scroll: { type: "scroll", direction: "down", amount: 3 },
  find_text: { type: "find_text", text: "Add to cart" },
  http_get: { type: "http_get", url: "https://api.example.com/v1/items" },
  navigate: { type: "navigate", url: "https://shop.example/checkout" },
  follow_link: { type: "follow_link", elementId: "more" },
  click: { type: "click", elementId: "pay" },
  type: { type: "type", elementId: "pw", text: "hunter2" },
  select_option: { type: "select_option", elementId: "note", label: "Germany" },
  click_at: { type: "click_at", observationId: "obs1", x: 5, y: 5 },
  type_at: { type: "type_at", observationId: "obs1", x: 45, y: 5, text: "4111 1111 1111 1111" },
  press_key: { type: "press_key", observationId: "obs1", key: "Enter" },
  play_loop: { type: "play_loop", observationId: "obs1", seconds: 10, lanes: [{ x: 0.3, y: 0.8, key: "d", color: [255, 0, 0], tolerance: 60 }] },
  submit_form: { type: "submit_form", elementId: "pay" },
  download: { type: "download" },
};
// For the effect check "applies" needs a destructive control under the point.
const CRAFTED_EFFECT = {
  click_at: { type: "click_at", observationId: "obs1", x: 25, y: 5 },
  type_at: { type: "type_at", observationId: "obs1", x: 25, y: 5, text: "x" },
};

const result = (check, action) => {
  const out = inspectAction(action, ctx);
  return check === "privacy" ? out.privacy : check === "payment" ? out.paymentTarget : out.effect;
};

test("every action type is declared for every check, and no declaration is stale", () => {
  assert.deepEqual(Object.keys(SAFETY_DECLARATIONS).sort(), [...ACTIONS].sort(), "ACTIONS and SAFETY_DECLARATIONS list the same action types");
  for (const type of ACTIONS) {
    for (const check of CHECKS) {
      const d = SAFETY_DECLARATIONS[type][check];
      assert.equal(typeof d?.applies, "boolean", `${type}.${check} declares applies true or false`);
      assert.ok(typeof d.reason === "string" && d.reason.length >= 10, `${type}.${check} says why`);
    }
    assert.ok(CRAFTED[type], `test has a crafted action for ${type}`);
  }
});

test("a declared 'applies' really triggers the check, and a declared 'not-applicable' really returns nothing", () => {
  for (const type of ACTIONS) {
    for (const check of CHECKS) {
      const declared = SAFETY_DECLARATIONS[type][check].applies;
      const action = check === "effect" && declared ? CRAFTED_EFFECT[type] : CRAFTED[type];
      const got = result(check, action);
      if (declared) assert.ok(got, `${type} declares ${check} applies, but the check returned nothing`);
      else assert.equal(got ?? null, null, `${type} declares ${check} not-applicable, but the check returned ${JSON.stringify(got)}`);
    }
  }
});

test("the checks behave: secret typing is blocked, a payment control is found, a destructive control is denied", () => {
  assert.equal(inspectAction(CRAFTED.type, ctx).privacy.tier, 3);
  assert.equal(inspectAction({ type: "type", elementId: "note", text: "happy birthday" }, ctx).privacy, null);
  assert.equal(inspectAction(CRAFTED.click, ctx).paymentTarget.name, "Place order");
  assert.equal(inspectAction({ type: "click", elementId: "more" }, ctx).paymentTarget, null);
  assert.equal(inspectAction(CRAFTED_EFFECT.click_at, ctx).effect.gate, "deny");
  assert.equal(inspectAction(CRAFTED.click_at, { ...ctx, computerUse: false }).effect, null, "no effect verdict without a computer-use profile");
  assert.equal(inspectAction(CRAFTED.click_at, { ...ctx, screenTargets: { observationId: "other", targets } }).paymentTarget, null, "stale screen map is not trusted");
});

test("an action type that is not declared is treated as unchecked and reported, never silently passed", () => {
  const out = inspectAction({ type: "hw_step", step: { op: "fill" } }, ctx);
  assert.equal(out.undeclared, true, "the dispatch loop can refuse or ask for an undeclared type");
  assert.equal(inspectAction({ type: "observe" }, ctx).undeclared, undefined);
});

test("submitting a whole form that holds a payment button is a payment, whatever the form itself is called", () => {
  const checkout = {
    id: "obs2", url: "https://shop.example/checkout", documentEpoch: 1,
    elements: [
      { elementId: "0", role: "form", name: "Checkout", formAction: "https://shop.example/order", formMethod: "post", parentElementId: null },
      { elementId: "1", role: "text", name: "Total $480.00", parentElementId: "0" },
      { elementId: "2", role: "group", name: "", parentElementId: "0" },
      { elementId: "3", role: "button", name: "Place order", formAction: "https://shop.example/order", formMethod: "post", parentElementId: "2" },
      { elementId: "4", role: "form", name: "Search", formAction: "https://shop.example/search", formMethod: "get", parentElementId: null },
      { elementId: "5", role: "button", name: "Search", formAction: "https://shop.example/search", formMethod: "get", parentElementId: "4" },
      // A payment button outside its form (<button form="...">) still submits that form.
      { elementId: "6", role: "form", name: "", formAction: "https://shop.example/pay", formMethod: "post", parentElementId: null },
      { elementId: "7", role: "button", name: "Pay now", formAction: "https://shop.example/pay", formMethod: "post", parentElementId: null },
    ],
  };
  const c = { observation: checkout, screenTargets: null, computerUse: false, userText: "" };
  assert.equal(inspectAction({ type: "submit_form", elementId: "0" }, c).paymentTarget?.name, "Place order", "a nested payment button makes the form a payment");
  assert.equal(inspectAction({ type: "submit_form", elementId: "6" }, c).paymentTarget?.name, "Pay now", "a payment button that submits to the same place counts too");
  assert.equal(inspectAction({ type: "submit_form", elementId: "4" }, c).paymentTarget, null, "a search form is not a payment");
});
