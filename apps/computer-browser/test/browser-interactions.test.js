"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

function page(options = {}) {
  const events = [];
  class Element {
    constructor(tag, attrs = {}, text = "") {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.textContent = text;
      this.innerText = text; this.nodeType = 1; this.children = []; this.isConnected = true;
      this.childElementCount = 0; this.parentElement = null;
    }
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
    getClientRects() { return [{ width: 20, height: 20 }]; }
    focus() { events.push("focus"); }
    click() { events.push("click"); if (this.onClick) this.onClick(); }
    dispatchEvent(e) { events.push(e.type); return true; }
    matches(s) { return s === ":disabled" && !!this.disabled; }
  }
  class Input extends Element {
    constructor(attrs) { super("input", attrs); this._value = ""; }
    get value() { return this._value; }
    set value(v) { this._value = v; }
  }
  class Textarea extends Element { get value() { return this._value || ""; } set value(v) { this._value = v; } }
  class Form extends Element { requestSubmit(button) { events.push("submit"); this.submitter = button; } }
  const body = new Element("body");
  const button = new Element("button", { type: "button" }, "Save");
  const input = new Input({ type: "text", "aria-label": "Title" });
  const form = new Form("form", { "aria-label": "Profile", action: "/save", method: "post" });
  form.action = "https://example.test/save"; form.method = "post";
  const submit = new Element("button", { type: "submit" }, "Submit"); submit.form = form;
  body.children = [button, input, form]; form.children = [submit]; form.childElementCount = 1;
  const all = [body, button, input, form, submit];
  for (const n of body.children) n.parentElement = body; submit.parentElement = form;
  const document = { body, documentElement: body, baseURI: "https://example.test/", title: "Test",
    getElementById: () => null,
    createTreeWalker: () => { let i = 0; return { currentNode: body, nextNode: () => all[++i] || null }; },
  };
  const sandbox = vm.createContext({ document, NodeFilter: { SHOW_ELEMENT: 1 }, URL,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLFormElement: Form,
    Event: class { constructor(type) { this.type = type; } },
    InputEvent: class { constructor(type) { this.type = type; } },
  });
  const wc = new EventEmitter();
  wc.getURL = () => document.baseURI; wc.getTitle = () => document.title;
  wc.executeJavaScriptInIsolatedWorld = async (_world, scripts) => vm.runInContext(scripts[0].code, sandbox);
  wc.executeJavaScript = async () => { throw new Error("interaction must use isolated world"); };
  const browser = new BrowserAdapter({ view: { webContents: wc }, permissionMode: "full", ...options });
  return { browser, wc, events, button, input, form, submit, document, all };
}

async function actionFor(p, type, name, extra = {}) {
  const observation = await p.browser.observe();
  const element = observation.elements.find(e => e.name === name);
  assert.ok(element, `missing ${name}`);
  return { action: { type, elementId: element.elementId, ...extra }, documentEpoch: observation.documentEpoch };
}

test("click dispatches on the observed DOM node in an isolated world, once", async () => {
  const p = page(), { action, documentEpoch } = await actionFor(p, "click", "Save");
  assert.equal(p.browser.supportsAction("click"), true);
  assert.equal((await p.browser.execute(action, { documentEpoch })).status, "ok");
  assert.deepEqual(p.events, ["click"]);
  assert.equal((await p.browser.execute(action, { documentEpoch })).status, "failed");
  assert.deepEqual(p.events, ["click"]);
});

test("type uses a native setter and input/change events without evaluating user text", async () => {
  const p = page(), text = '한글 ${globalThis.pwned=true} \\" </script>';
  const { action, documentEpoch } = await actionFor(p, "type", "Title", { text });
  assert.equal((await p.browser.execute(action, { documentEpoch })).status, "ok");
  assert.equal(p.input.value, text);
  assert.deepEqual(p.events, ["focus", "beforeinput", "input", "change"]);
});

test("submit_form uses requestSubmit and preserves the observed submitter", async () => {
  const p = page(), { action, documentEpoch } = await actionFor(p, "submit_form", "Submit");
  assert.equal((await p.browser.execute(action, { documentEpoch })).status, "ok");
  assert.equal(p.form.submitter, p.submit);
  assert.deepEqual(p.events, ["submit"]);
});

test("a detached or replaced target never falls back to a new node at the same index", async () => {
  const p = page(), { action, documentEpoch } = await actionFor(p, "click", "Save");
  p.button.isConnected = false;
  assert.equal((await p.browser.execute(action, { documentEpoch })).errorCode, "stale_element");
  assert.deepEqual(p.events, []);
});

test("changed accessible identity, disabled targets, and changed form destination are refused", async () => {
  for (const change of [p => { p.button.textContent = p.button.innerText = "Pay"; },
    p => { p.button.disabled = true; }, p => { p.button.attrs.hidden = ""; }]) {
    const p = page(), { action, documentEpoch } = await actionFor(p, "click", "Save"); change(p);
    assert.equal((await p.browser.execute(action, { documentEpoch })).status, "failed");
    assert.deepEqual(p.events, []);
  }
  const p = page(), { action, documentEpoch } = await actionFor(p, "submit_form", "Submit");
  p.form.action = "https://other.test/pay";
  assert.equal((await p.browser.execute(action, { documentEpoch })).errorCode, "stale_element");
  assert.deepEqual(p.events, []);
});

test("password/file fields and excessive text stay outside ordinary type actions", async () => {
  for (const inputType of ["password", "file"]) {
    const p = page(); p.input.attrs.type = inputType;
    const { action, documentEpoch } = await actionFor(p, "type", "Title", { text: "secret" });
    assert.equal((await p.browser.execute(action, { documentEpoch })).errorCode, "unsupported_input");
    assert.equal(p.input.value, "");
  }
  const p = page(), { action, documentEpoch } = await actionFor(p, "type", "Title", { text: "a".repeat(4097) });
  assert.equal((await p.browser.execute(action, { documentEpoch })).errorCode, "invalid_action");
  assert.equal(p.input.value, "");
});

test("abort and stale-document checks happen before any interaction", async () => {
  const p = page(), { action, documentEpoch } = await actionFor(p, "click", "Save");
  const abort = new AbortController(); abort.abort();
  assert.equal((await p.browser.execute(action, { signal: abort.signal, documentEpoch })).status, "cancelled");
  p.wc.emit("did-navigate");
  assert.equal((await p.browser.execute(action, { documentEpoch })).errorCode, "stale_document");
  assert.deepEqual(p.events, []);
});

test("script rejection after dispatch is uncertain and never retried", async () => {
  const p = page(), { action, documentEpoch } = await actionFor(p, "click", "Save");
  p.wc.executeJavaScriptInIsolatedWorld = async () => { p.events.push("click"); throw new Error("renderer lost after effect"); };
  assert.equal((await p.browser.execute(action, { documentEpoch })).status, "uncertain");
  assert.equal((await p.browser.execute(action, { documentEpoch })).status, "failed");
  assert.deepEqual(p.events, ["click"]);
});

test("mode, intent-lock and widened-origin checks cannot be bypassed by interactions", async () => {
  const { makeIntentLock } = require("../shared/harness-contracts");
  const p = page(), { action, documentEpoch } = await actionFor(p, "click", "Save");
  p.browser.setPermissionMode("observe");
  assert.equal((await p.browser.execute(action, { documentEpoch })).errorCode, "permission_mode_denied");
  assert.equal((await p.browser.execute(action, { documentEpoch, widenedBy: { kind: "user_once", origin: "https://other.test" } })).errorCode, "widened_origin_mismatch");
  p.browser.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_action", action: "click" }] }));
  assert.equal((await p.browser.execute(action, { documentEpoch, widenedBy: { kind: "user_once" } })).errorCode, "intent_lock_denied");
  assert.deepEqual(p.events, []);
});

test("page-initiated downloads are cancelled only for this adapter and listener is removed on dispose", async () => {
  const session = new EventEmitter(), wc = new EventEmitter();
  Object.assign(wc, { session, id: 31, close() {} });
  const browser = new BrowserAdapter({ view: { webContents: wc } });
  let cancelled = 0;
  const item = { cancel: () => cancelled++ };
  session.emit("will-download", {}, item, { id: 32 });
  assert.equal(cancelled, 0);
  session.emit("will-download", {}, item, wc);
  assert.equal(cancelled, 1);
  await browser.dispose();
  assert.equal(session.listenerCount("will-download"), 0);
});

test("hung dispatch times out as uncertain and bars new observation until its real completion", async () => {
  const p = page({ interactionTimeoutMs: 20 }), { action, documentEpoch } = await actionFor(p, "click", "Save");
  let complete;
  p.wc.executeJavaScriptInIsolatedWorld = () => new Promise(resolve => { complete = resolve; });
  const outcome = await p.browser.execute(action, { documentEpoch });
  assert.equal(outcome.status, "uncertain");
  assert.equal(outcome.errorCode, "interaction_timeout");
  await assert.rejects(p.browser.observe(), { code: "interaction_pending" });
  complete({ status: "ok" }); await Promise.resolve();
});
