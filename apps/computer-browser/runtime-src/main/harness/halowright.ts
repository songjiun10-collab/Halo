"use strict";

// One Halowright step: find the element by name, wait until it can be used, act on it,
// then check that the page really changed -- except get_text, which only reads the
// element's text and sends no input. This module never decides whether an action
// is allowed: it dispatches raw input, so it refuses to touch the page unless the caller
// supplies the host's authorization decision (options.authorize). The gate -- Intent
// Lock, permission mode, lease, effect classification -- lives in the host; wiring it to
// authorize is the only supported way to call this, so no caller can bypass it.

const verifier = require("./effect-verifier") as {
  PAGE_SNAPSHOT_SOURCE: string;
  parseSnapshot(raw: unknown): any;
  verifyEffect(options: { before: any; read: () => Promise<any>; sleep: (ms: number) => Promise<void>; timeoutMs?: number }): Promise<{ observed: boolean; changed: string[] }>;
};
const locators = require("./halowright-locator") as {
  HalowrightError: new (code: string, message: string) => Error & { code: string };
  validateLocator(value: unknown): any;
  locatorResolveSource(spec: any, settle?: boolean): string;
  waitForActionable(options: any): Promise<any>;
};

const contract = require("./computer-use-contract") as { ALLOWED_KEYS: readonly string[] };

const WORLD_ID = 1001;
const MAX_FILL_BYTES = 4096;
const MAX_SCROLL = 5000;
// Read-only text extraction budget: the planner gets at most this many UTF-8
// bytes per element, with a truncation flag, so one huge node cannot blow up
// the rebuilt planner context.
const MAX_TEXT_BYTES = 4096;
const NEEDS_LOCATOR = new Set(["click", "fill", "hover", "check", "uncheck", "select", "get_text"]);

type Op = "click" | "fill" | "hover" | "press" | "check" | "uncheck" | "select" | "scroll" | "get_text";
const HW_STEP_OPS: readonly Op[] = Object.freeze(["click", "fill", "hover", "press", "check", "uncheck", "select", "scroll", "get_text"]);
// The canonical browser action a hw op is judged as: Intent Lock, permission
// mode, lease, approval prompt and effect classification all use the same name
// the equivalent elementId action uses, so a step can never be gated as
// something weaker than it performs. get_text is read-only and gated as find.
const HW_OP_GATE_ACTIONS: Readonly<Record<Op, string>> = Object.freeze({ click: "click", fill: "type", press: "press_key", scroll: "scroll", check: "click", uncheck: "click", select: "click", hover: "scroll", get_text: "find" });
interface WebContentsLike {
  sendInputEvent(event: Record<string, unknown>): void;
  insertText?(text: string): void;
  selectAll?(): void;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<any>;
}
interface StepResult {
  status: "ok" | "failed" | "uncertain";
  errorCode?: string;
  effect?: { observed: boolean; changed: string[] };
  candidates?: string[];
  // get_text only: the element's text (truncated to MAX_TEXT_BYTES) and whether it was cut.
  text?: string;
  truncated?: boolean;
}
interface StepOptions {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  // Host gate. Required: runHwStep dispatches raw input (sendInputEvent/insertText),
  // so it refuses to act unless the caller wires the host's own decision here. The
  // host resolves the element (effect-classifier) and checks the Intent Lock,
  // permission mode and any lease, then returns true only for an allow. A missing,
  // throwing, or non-true result fails closed before any input is sent.
  authorize?: (request: { step: { op: Op; text?: string; key?: string; value?: string; dy?: number }; target: { x: number; y: number; tag: string; role?: string; name?: string; inputType?: string } }) => boolean | Promise<boolean>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runScript(wc: WebContentsLike, code: string): Promise<any> {
  const raw = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
  return Array.isArray(raw) ? raw[0] : raw;
}

// Host-built, runs at a point the host already authorized; the model's value is JSON-encoded, never code.
const selectSource = (x: number, y: number, value: string) => `((x, y, want) => {
  const el = document.elementFromPoint(x, y);
  const sel = el && (el.tagName === "SELECT" ? el : el.closest && el.closest("select"));
  if (!sel) return JSON.stringify({ ok: false });
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const i = [...sel.options].findIndex((o) => !o.disabled && (o.value === want || norm(o.text) === norm(want)));
  if (i < 0) return JSON.stringify({ ok: false, reason: "no_option" });
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return JSON.stringify({ ok: sel.selectedIndex === i, text: sel.options[i].text });
})(${x}, ${y}, ${JSON.stringify(value)})`;
// Does the focused field now hold exactly the requested text? Stronger than a length change, which a prior field of equal length can mask.
const fieldHoldsSource = (text: string) => `((want) => { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return !!e && (typeof e.value === "string" ? e.value === want : !!e.isContentEditable && e.textContent === want); })(${JSON.stringify(text)})`;
const SCROLL_SOURCE = `JSON.stringify({ y: Math.round((document.scrollingElement || document.documentElement).scrollTop), w: innerWidth, h: innerHeight })`;
// Reads the visible text of the element under the resolved point. The model's
// value never enters this script: only host-measured coordinates do. Marked so
// test doubles can answer text reads without consuming locator resolutions.
const TEXT_AT_SOURCE = (x: number, y: number) => `((x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return JSON.stringify({ ok: false, text: "" });
  const scope = (el.tagName === "SELECT" || el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? el : (el.closest && el.closest("select,input,textarea")) || el;
  let text = "";
  if (scope.tagName === "INPUT" || scope.tagName === "TEXTAREA") text = typeof scope.value === "string" ? scope.value : "";
  else if (scope.tagName === "SELECT") text = scope.options && scope.selectedIndex >= 0 ? String(scope.options[scope.selectedIndex].text || "") : "";
  else text = String(scope.innerText ?? scope.textContent ?? "");
  return JSON.stringify({ ok: true, text, marker: "halowrightGetText" });
})(${x}, ${y})`;

// Cuts text to a UTF-8 byte budget without splitting a multibyte sequence.
function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const source = Buffer.from(text, "utf8");
  if (source.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return { text: source.subarray(0, end).toString("utf8"), truncated: true };
}

type StepInput = { locator?: unknown; op?: unknown; text?: unknown; key?: unknown; value?: unknown; dy?: unknown };

// Shape/bounds only -- the checks runHwStep performs inline, exported so the
// host can reject a malformed hw_step proposal before it reaches the gate.
function validateStep(step: unknown): { ok: true; step: StepInput & { op: Op } } | { ok: false; errorCode: string } {
  const input = step as StepInput | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errorCode: "invalid_step" };
  const op = input.op as Op;
  if (!HW_STEP_OPS.includes(op)) return { ok: false, errorCode: "invalid_op" };
  if (op === "fill" && (typeof input.text !== "string" || Buffer.byteLength(input.text, "utf8") > MAX_FILL_BYTES)) return { ok: false, errorCode: "invalid_text" };
  if (op === "press" && (typeof input.key !== "string" || !contract.ALLOWED_KEYS.includes(input.key))) return { ok: false, errorCode: "invalid_key" };
  if (op === "select" && (typeof input.value !== "string" || input.value.length === 0 || input.value.length > 200)) return { ok: false, errorCode: "invalid_value" };
  if (op === "scroll" && !(Number.isInteger(input.dy) && input.dy !== 0 && Math.abs(input.dy as number) <= MAX_SCROLL)) return { ok: false, errorCode: "invalid_scroll" };
  if (NEEDS_LOCATOR.has(op) || (op === "scroll" && input.locator !== undefined)) {
    try { locators.validateLocator(input.locator); }
    catch (error: any) { return { ok: false, errorCode: error?.code === "invalid_locator" ? "invalid_locator" : "invalid_step" }; }
  }
  return { ok: true, step: input as StepInput & { op: Op } };
}

// Maps a hw op to the canonical browser action the host gates it as.
function gateActionFor(op: unknown): string | null {
  return typeof op === "string" && Object.prototype.hasOwnProperty.call(HW_OP_GATE_ACTIONS, op) ? HW_OP_GATE_ACTIONS[op as Op] : null;
}

async function runHwStep(wc: WebContentsLike, step: unknown, options: StepOptions = {}): Promise<StepResult> {
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 5000;
  const valid = validateStep(step);
  if (!valid.ok) return { status: "failed", errorCode: valid.errorCode };
  const input = valid.step as StepInput;
  const op = input.op as Op;
  let spec: any = null;
  if (NEEDS_LOCATOR.has(op) || (op === "scroll" && input.locator !== undefined)) {
    try { spec = locators.validateLocator(input.locator); }
    catch (error: any) { return { status: "failed", errorCode: error?.code === "invalid_locator" ? "invalid_locator" : "invalid_step" }; }
  }
  // Fail closed before any page contact: no authorization callback means no step.
  if (typeof options.authorize !== "function") return { status: "failed", errorCode: "authorization_required" };
  if (op === "fill" && typeof wc.insertText !== "function") return { status: "failed", errorCode: "input_unsupported" };

  const resolve = async (s: any) => {
    const raw = await runScript(wc, locators.locatorResolveSource(s, true));
    try { return JSON.parse(raw); } catch { return null; }
  };
  let target: any = { x: 0, y: 0, tag: op === "press" ? "KEYBOARD" : "VIEWPORT" };
  if (spec) {
    target = await locators.waitForActionable({ resolve, spec, sleep, timeoutMs });
    if (target.status === "ambiguous") return { status: "failed", errorCode: "locator_ambiguous", candidates: target.candidates ?? [] };
    if (target.status === "not_found") return { status: "failed", errorCode: "locator_not_found" };
    if (target.status !== "resolved") return { status: "failed", errorCode: `not_actionable_${target.reason}` };
  }
  // get_text is read-only: authorize the resolved element, read its text, and
  // return it. No input is ever sent and no page effect is expected, so the
  // snapshot/effect machinery below is skipped for this op.
  if (op === "get_text") {
    let authorized = false;
    try {
      authorized = (await options.authorize({
        step: { op },
        target: { x: target.x, y: target.y, tag: String(target.tag ?? ""), ...(target.role ? { role: String(target.role) } : {}), ...(target.name ? { name: String(target.name) } : {}), ...(target.inputType ? { inputType: String(target.inputType) } : {}) },
      })) === true;
    } catch { authorized = false; }
    if (!authorized) return { status: "failed", errorCode: "not_authorized" };
    let parsed: any = null;
    try { parsed = JSON.parse(await runScript(wc, TEXT_AT_SOURCE(target.x, target.y))); } catch { /* handled below */ }
    if (!parsed || parsed.ok !== true || typeof parsed.text !== "string") return { status: "uncertain", errorCode: "text_unreadable" };
    const { text, truncated } = truncateUtf8Bytes(parsed.text, MAX_TEXT_BYTES);
    return { status: "ok", text, truncated };
  }
  const read = async () => verifier.parseSnapshot(await runScript(wc, verifier.PAGE_SNAPSHOT_SOURCE));
  const before = await read().catch(() => null);
  // Without a readable "before" the effect can never be verified, so do nothing at all.
  if (!before) return { status: "failed", errorCode: "effect_unverifiable" };
  let scrollBefore: any = null;
  if (op === "scroll") {
    try { scrollBefore = JSON.parse(await runScript(wc, SCROLL_SOURCE)); } catch { return { status: "failed", errorCode: "effect_unverifiable" }; }
    if (!spec) target = { x: Math.round(scrollBefore.w / 2), y: Math.round(scrollBefore.h / 2), tag: "VIEWPORT" };
  }
  // check/uncheck that is already satisfied needs no input at all.
  const want = op === "check" ? true : op === "uncheck" ? false : null;
  if (want !== null && target.checked === undefined) return { status: "failed", errorCode: "not_checkable" };

  // Authorize the resolved target before any input. The host decides from this
  // element (not from a locator string); a throw or any non-true answer sends nothing.
  let authorized = false;
  try {
    authorized = (await options.authorize({
      step: { op, ...(op === "fill" ? { text: input.text as string } : {}), ...(op === "press" ? { key: input.key as string } : {}), ...(op === "select" ? { value: input.value as string } : {}), ...(op === "scroll" ? { dy: input.dy as number } : {}) },
      target: { x: target.x, y: target.y, tag: String(target.tag ?? ""), ...(target.role ? { role: String(target.role) } : {}), ...(target.name ? { name: String(target.name) } : {}), ...(target.inputType ? { inputType: String(target.inputType) } : {}) },
    })) === true;
  } catch { authorized = false; }
  if (!authorized) return { status: "failed", errorCode: "not_authorized" };

  const { x, y } = target;
  const click = () => {
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  };
  const none = { observed: false, changed: [] as string[] };
  if (op === "hover") { wc.sendInputEvent({ type: "mouseMove", x, y }); return { status: "ok", effect: none }; }
  if (want !== null) {
    if (target.checked === want) return { status: "ok", effect: none };
    click();
    const after = await resolve(spec).catch(() => null);
    return after?.status === "resolved" && after.checked === want ? { status: "ok", effect: { observed: true, changed: ["checked"] } } : { status: "uncertain", errorCode: "effect_not_observed" };
  }
  if (op === "select") {
    let chosen: any = null;
    try { chosen = JSON.parse(await runScript(wc, selectSource(x, y, input.value as string))); } catch { /* handled below */ }
    if (chosen?.reason === "no_option") return { status: "failed", errorCode: "option_not_found" };
    return chosen?.ok ? { status: "ok", effect: { observed: true, changed: ["selected"] } } : { status: "uncertain", errorCode: "effect_not_observed" };
  }
  if (op === "scroll") {
    wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: -(input.dy as number) });
    for (let waited = 0; waited <= 300; waited += 50) {
      await sleep(50);
      try {
        const now = JSON.parse(await runScript(wc, SCROLL_SOURCE));
        if (now.y !== scrollBefore.y) return { status: "ok", effect: { observed: true, changed: ["scroll"] } };
      } catch { /* retry */ }
    }
    return { status: "uncertain", errorCode: "effect_not_observed" };
  }
  if (op === "press") {
    const key = input.key as string;
    wc.sendInputEvent({ type: "keyDown", keyCode: key });
    if (key === "Enter") wc.sendInputEvent({ type: "char", keyCode: "Enter" });
    wc.sendInputEvent({ type: "keyUp", keyCode: key });
  } else {
    click();
    if (op === "fill") {
      wc.selectAll?.();
      wc.insertText!(input.text as string);
    }
  }
  const effect = await verifier.verifyEffect({ before, read, sleep });
  // A click or fill is not retried: it may already have had a side effect.
  // A fill only counts when the field content changed; focus or title changes alone prove nothing.
  let done = effect.observed;
  if (op === "fill") {
    const holds = (await runScript(wc, fieldHoldsSource(input.text as string)).catch(() => false)) === true;
    done = holds || effect.changed.includes("valueLength") || effect.changed.includes("textLength");
  }
  return done ? { status: "ok", effect } : { status: "uncertain", errorCode: "effect_not_observed" };
}

export = { runHwStep, validateStep, gateActionFor, HW_STEP_OPS, HW_OP_GATE_ACTIONS };
