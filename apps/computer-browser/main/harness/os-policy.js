// Generated from runtime-src/main/harness/os-policy.ts. Do not edit; run npm run build:runtime.
"use strict";
// What the agent may do on the person's own computer outside the browser. Pure decisions, no I/O:
// the OS backend only ever sees an action this module has let through. Everything here is
// default-deny: an app the person did not list, a protected window, a secure field or a control the
// host cannot classify never gets an automatic click. Window titles and control names come from the
// other app, so they can only add a question (via the effect classifier), never remove one.
const { classifyTarget } = require("./effect-classifier");
// Never touched, even when the person lists them: credentials, system settings, a shell, Halo itself.
const PROTECTED_BUNDLES = new Set([
    "com.apple.keychainaccess", "com.apple.systempreferences", "com.apple.Passwords", "com.apple.Terminal",
    "com.googlecode.iterm2", "com.apple.ScreenSharing", "com.apple.loginwindow", "com.apple.SecurityAgent",
    "com.apple.Console", "com.apple.ActivityMonitor", "com.1password.1password", "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
]);
const PROTECTED_PREFIXES = Object.freeze(["com.apple.preference", "com.halo.", "com.anthropic."]);
const DEFAULT_MAX_ACTIONS = 100;
const isProtected = (bundleId) => PROTECTED_BUNDLES.has(bundleId) || PROTECTED_PREFIXES.some((prefix) => bundleId.startsWith(prefix));
const deny = (reason) => ({ gate: "deny", reason });
// Whether the app in front may be seen or driven at all. Judged only by bundle identifier: a title or
// display name is what the other app says about itself.
function windowDecision(window, options) {
    const bundleId = typeof window?.bundleId === "string" ? window.bundleId : "";
    if (!bundleId)
        return deny("the window has no bundle identifier");
    if (isProtected(bundleId))
        return deny("this app is protected: credentials, system settings, a shell or Halo itself");
    if (!Array.isArray(options.allowedApps) || options.allowedApps.length === 0)
        return deny("no app is allowed");
    if (!options.allowedApps.includes(bundleId))
        return deny("the app is not on the allowed list");
    const max = Number.isInteger(options.maxActions) && options.maxActions > 0 ? options.maxActions : DEFAULT_MAX_ACTIONS;
    if ((options.actionsUsed ?? 0) >= max)
        return deny("the OS action limit for this task is used up");
    return { gate: "auto", reason: "app allowed" };
}
// A click at a point: the window rule first, then the control under the point.
function clickDecision(window, target, options) {
    const base = windowDecision(window, options);
    if (base.gate !== "auto")
        return base;
    if (target?.secure)
        return deny("the control is a secure field");
    const verdict = classifyTarget(target, "click_at");
    return { gate: verdict.gate, reason: verdict.reason };
}
// Text typed into the focused control. A secure field or a non-text control is never typed into.
function typeDecision(window, focused, options) {
    const base = windowDecision(window, options);
    if (base.gate !== "auto")
        return base;
    if (!focused)
        return { gate: "ask", reason: "no focused control is known" };
    if (focused.secure)
        return deny("the focused control is a secure field");
    const verdict = classifyTarget(focused, "type_at");
    return { gate: verdict.gate, reason: verdict.reason };
}
// Keys: plain editing and movement keys pass; anything with a command/control/option modifier, and Enter
// (which can submit or confirm), waits for the person.
const SAFE_KEYS = new Set(["Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
function keyDecision(window, key, options) {
    const base = windowDecision(window, options);
    if (base.gate !== "auto")
        return base;
    if (typeof key !== "string" || key.length === 0 || key.length > 32)
        return deny("the key is not valid");
    if (/^(?:Meta|Cmd|Command|Control|Ctrl|Alt|Option)\+/i.test(key))
        return { gate: "ask", reason: "a shortcut with a modifier key" };
    if (key === "Enter" || key === "Return")
        return { gate: "ask", reason: "Enter can submit or confirm" };
    return SAFE_KEYS.has(key) ? { gate: "auto", reason: "movement or editing key" } : { gate: "ask", reason: "a key the host cannot rule out as effect-bearing" };
}
module.exports = { windowDecision, clickDecision, typeDecision, keyDecision, isProtected };
