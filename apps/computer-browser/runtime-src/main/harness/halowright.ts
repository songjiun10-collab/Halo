"use strict";

// One Halowright step: find the element by name, wait until it can be used, act on it,
// then check that the page really changed. Approval and effect classification happen
// above this layer; this module never decides whether an action is allowed.

const verifier = require("./effect-verifier") as {
  PAGE_SNAPSHOT_SOURCE: string;
  parseSnapshot(raw: unknown): any;
  verifyEffect(options: { before: any; read: () => Promise<any>; sleep: (ms: number) => Promise<void>; timeoutMs?: number }): Promise<{ observed: boolean; changed: string[] }>;
};
const locators = require("./halowright-locator") as {
  HalowrightError: new (code: string, message: string) => Error & { code: string };
  validateLocator(value: unknown): any;
  locatorResolveSource(spec: any): string;
  waitForActionable(options: any): Promise<any>;
};

const WORLD_ID = 1001;
const MAX_FILL_BYTES = 4096;

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
}
interface StepOptions { sleep?: (ms: number) => Promise<void>; timeoutMs?: number }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runScript(wc: WebContentsLike, code: string): Promise<any> {
  const raw = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
  return Array.isArray(raw) ? raw[0] : raw;
}

async function runHwStep(wc: WebContentsLike, step: unknown, options: StepOptions = {}): Promise<StepResult> {
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 5000;
  const input = step as { locator?: unknown; op?: unknown; text?: unknown } | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: "failed", errorCode: "invalid_step" };
  if (input.op !== "click" && input.op !== "fill") return { status: "failed", errorCode: "invalid_op" };
  if (input.op === "fill" && (typeof input.text !== "string" || Buffer.byteLength(input.text, "utf8") > MAX_FILL_BYTES)) return { status: "failed", errorCode: "invalid_text" };
  let spec: any;
  try { spec = locators.validateLocator(input.locator); }
  catch (error: any) { return { status: "failed", errorCode: error?.code === "invalid_locator" ? "invalid_locator" : "invalid_step" }; }

  const resolve = async (s: any) => {
    const raw = await runScript(wc, locators.locatorResolveSource(s));
    try { return JSON.parse(raw); } catch { return null; }
  };
  const target = await locators.waitForActionable({ resolve, spec, sleep, timeoutMs });
  if (target.status === "ambiguous") return { status: "failed", errorCode: "locator_ambiguous", candidates: target.candidates ?? [] };
  if (target.status === "not_found") return { status: "failed", errorCode: "locator_not_found" };
  if (target.status !== "resolved") return { status: "failed", errorCode: `not_actionable_${target.reason}` };

  if (input.op === "fill" && typeof wc.insertText !== "function") return { status: "failed", errorCode: "input_unsupported" };
  const read = async () => verifier.parseSnapshot(await runScript(wc, verifier.PAGE_SNAPSHOT_SOURCE));
  const before = await read().catch(() => null);
  // Without a readable "before" the effect can never be verified, so do nothing at all.
  if (!before) return { status: "failed", errorCode: "effect_unverifiable" };
  const { x, y } = target;
  wc.sendInputEvent({ type: "mouseMove", x, y });
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  if (input.op === "fill") {
    wc.selectAll?.();
    wc.insertText!(input.text as string);
  }
  const effect = await verifier.verifyEffect({ before, read, sleep });
  // A click or fill is not retried: it may already have had a side effect.
  // A fill only counts when the field content changed; focus or title changes alone prove nothing.
  const done = input.op === "fill" ? effect.changed.includes("valueLength") || effect.changed.includes("textLength") : effect.observed;
  return done ? { status: "ok", effect } : { status: "uncertain", errorCode: "effect_not_observed" };
}

export = { runHwStep };
