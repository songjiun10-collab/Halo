// Generated from runtime-src/main/harness/halowright-locator.ts. Do not edit; run npm run build:runtime.
"use strict";
class HalowrightError extends Error {
    code;
    constructor(code, message) { super(`${code}: ${message}`); this.name = "HalowrightError"; this.code = code; }
}
const MAX_TEXT = 200;
const ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "heading", "tab", "menuitem", "option", "switch"];
function validateLocator(value) {
    const fail = (why) => { throw new HalowrightError("invalid_locator", why); };
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail("locator must be an object");
    const spec = value;
    const keys = Object.keys(spec);
    const forms = ["role", "label", "text", "placeholder"].filter((key) => key in spec);
    if (forms.length !== 1)
        return fail("exactly one of role, label, text, placeholder");
    const allowed = new Set([forms[0], "nth", ...(forms[0] === "role" ? ["name"] : [])]);
    if (keys.some((key) => !allowed.has(key)))
        return fail("unknown field");
    const str = (key) => {
        const v = spec[key];
        if (typeof v !== "string" || v.length === 0 || v.length > MAX_TEXT)
            return fail(`${key} must be 1..${MAX_TEXT} characters`);
        return v;
    };
    if ("nth" in spec && !(Number.isInteger(spec.nth) && spec.nth >= 0 && spec.nth < 50))
        return fail("nth must be 0..49");
    const nth = "nth" in spec ? { nth: spec.nth } : {};
    if (forms[0] === "role") {
        const role = str("role");
        if (!ROLES.includes(role))
            return fail("unsupported role");
        return { role, ...("name" in spec ? { name: str("name") } : {}), ...nth };
    }
    return { [forms[0]]: str(forms[0]), ...nth };
}
// Runs in the isolated world and returns a ResolveResult as JSON.
function locatorResolveSource(spec) {
    return `((spec) => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const IMPLICIT = { button: "button,[role=button],input[type=button],input[type=submit]", link: "a[href],[role=link]", textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=url],input[type=tel],input[type=password],textarea,[role=textbox]", checkbox: "input[type=checkbox],[role=checkbox]", radio: "input[type=radio],[role=radio]", combobox: "select,[role=combobox]", heading: "h1,h2,h3,h4,h5,h6,[role=heading]", tab: "[role=tab]", menuitem: "[role=menuitem]", option: "option,[role=option]", switch: "[role=switch]" };
    const nameOf = (el) => norm(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder"));
    let list = [];
    if (spec.role) list = [...document.querySelectorAll(IMPLICIT[spec.role])].filter((el) => spec.name === undefined || nameOf(el) === norm(spec.name));
    else if (spec.label) list = [...document.querySelectorAll("input,textarea,select")].filter((el) => (el.labels && [...el.labels].some((l) => norm(l.innerText) === norm(spec.label))) || norm(el.getAttribute("aria-label")) === norm(spec.label));
    else if (spec.placeholder) list = [...document.querySelectorAll("[placeholder]")].filter((el) => norm(el.getAttribute("placeholder")) === norm(spec.placeholder));
    else if (spec.text) list = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && norm(el.innerText || el.textContent) === norm(spec.text));
    const rendered = list.filter((el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; });
    if (rendered.length > 0) list = rendered;
    const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ":" + nameOf(el).slice(0, 40);
    if (list.length === 0) return JSON.stringify({ status: "not_found" });
    const index = spec.nth === undefined ? (list.length === 1 ? 0 : -1) : spec.nth;
    if (index === -1) return JSON.stringify({ status: "ambiguous", count: list.length, candidates: list.slice(0, 5).map(label) });
    const el = list[index];
    if (!el) return JSON.stringify({ status: "not_found" });
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") return JSON.stringify({ status: "not_actionable", reason: "hidden" });
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return JSON.stringify({ status: "not_actionable", reason: "disabled" });
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) return JSON.stringify({ status: "not_actionable", reason: "covered" });
    return JSON.stringify({ status: "resolved", x, y, tag: el.tagName });
  })(${JSON.stringify(spec)})`;
}
async function waitForActionable({ resolve, spec, sleep, timeoutMs = 5000, intervalMs = 100 }) {
    let last = { status: "not_found" };
    let previous = null;
    let waited = 0;
    for (;;) {
        const sampled = await resolve(spec).catch(() => null);
        // A failed or empty sample is not a sighting: it breaks the stability streak and is never replayed as one.
        const current = sampled ?? (last.status === "resolved" ? { status: "not_found" } : last);
        last = current;
        if (current.status === "ambiguous")
            return { ...current, waitedMs: waited };
        if (current.status === "resolved") {
            if (previous && previous.x === current.x && previous.y === current.y)
                return { ...current, waitedMs: waited };
            previous = { x: current.x, y: current.y };
        }
        else
            previous = null;
        if (waited >= timeoutMs)
            break;
        await sleep(intervalMs);
        waited += intervalMs;
    }
    return last.status === "resolved" ? { status: "not_actionable", reason: "moving", waitedMs: waited } : { ...last, waitedMs: waited };
}
module.exports = { HalowrightError, validateLocator, locatorResolveSource, waitForActionable };
