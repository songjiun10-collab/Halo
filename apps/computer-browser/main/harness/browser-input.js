// Generated from runtime-src/main/harness/browser-input.ts. Do not edit; run npm run build:runtime.
"use strict";
const TYPES = new Set(["mouseMove", "mouseDown", "mouseUp", "mouseWheel", "keyDown", "keyUp", "insertText"]);
const MODIFIERS = new Set(["shift", "control", "alt", "meta"]);
function validateBrowserInput(value) {
    const fail = () => { throw Object.assign(new TypeError("invalid_field: invalid browser input"), { code: "invalid_field" }); };
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
        return fail();
    const input = value;
    if (!TYPES.has(input.type))
        return fail();
    const fields = input.type === "insertText" ? ["type", "text"] : input.type.startsWith("mouse")
        ? ["type", "nx", "ny", "button", "clickCount", "modifiers", ...(input.type === "mouseWheel" ? ["deltaX", "deltaY"] : [])]
        : ["type", "key", "modifiers"];
    if (Object.keys(input).some((key) => !fields.includes(key)))
        return fail();
    if (input.type === "insertText") {
        if (typeof input.text !== "string" || input.text.length < 1 || input.text.length > 16384 || input.text.includes("\0"))
            return fail();
        return { type: "insertText", text: input.text };
    }
    if (input.type.startsWith("mouse") && ![input.nx, input.ny].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
        return fail();
    if (input.type === "mouseWheel" && ![input.deltaX ?? 0, input.deltaY ?? 0].every((value) => Number.isFinite(value) && Math.abs(value) <= 100000))
        return fail();
    if (input.type.startsWith("key") && (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 16))
        return fail();
    if (input.button !== undefined && !["left", "middle", "right"].includes(input.button))
        return fail();
    if (input.clickCount !== undefined && !(Number.isInteger(input.clickCount) && input.clickCount >= 1 && input.clickCount <= 3))
        return fail();
    if (input.modifiers !== undefined && !(Array.isArray(input.modifiers) && input.modifiers.length <= 4 && input.modifiers.every((modifier) => MODIFIERS.has(modifier))))
        return fail();
    return { ...input, ...(input.modifiers ? { modifiers: [...input.modifiers] } : {}) };
}
function dispatchBrowserInput(wc, bounds, value) {
    const input = validateBrowserInput(value);
    if (input.type === "insertText") {
        wc.insertText(input.text);
        return true;
    }
    if (input.type.startsWith("mouse")) {
        if (![bounds.width, bounds.height].every((value) => Number.isFinite(value) && value > 0))
            return false;
        const event = { type: input.type, x: Math.round(input.nx * bounds.width), y: Math.round(input.ny * bounds.height), modifiers: input.modifiers ?? [] };
        if (input.type === "mouseDown" || input.type === "mouseUp")
            Object.assign(event, { button: input.button ?? "left", clickCount: input.clickCount ?? 1 });
        if (input.type === "mouseWheel")
            Object.assign(event, { deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
        wc.sendInputEvent(event);
        return true;
    }
    // Cmd/Ctrl+A performs the real select-all editing command. A synthesized
    // raw key event alone does not reliably trigger Blink's editing commands
    // (the same reason cdp-web-contents.selectAll sends commands:["selectAll"]),
    // so route it through the engine helper when one exists.
    const primaryModifier = (input.modifiers ?? []).some((modifier) => modifier === "meta" || modifier === "control");
    if (input.type === "keyDown" && primaryModifier && input.key.toLowerCase() === "a" && typeof wc.selectAll === "function") {
        wc.selectAll();
        return true;
    }
    wc.sendInputEvent({ type: input.type, keyCode: input.key, modifiers: input.modifiers ?? [] });
    if (input.type === "keyDown" && input.key.length === 1 && !(input.modifiers ?? []).some((modifier) => ["meta", "control", "alt"].includes(modifier)))
        wc.sendInputEvent({ type: "char", keyCode: input.key, modifiers: input.modifiers ?? [] });
    return true;
}
module.exports = { validateBrowserInput, dispatchBrowserInput };
