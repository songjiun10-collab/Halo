// Generated from runtime-src/main/harness/halowright-locator.ts. Do not edit; run npm run build:runtime.
"use strict";
class HalowrightError extends Error {
    code;
    constructor(code, message) { super(`${code}: ${message}`); this.name = "HalowrightError"; this.code = code; }
}
const MAX_TEXT = 200;
const ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "heading", "tab", "menuitem", "option", "switch"];
function validateLocator(value, nested = false) {
    const fail = (why) => { throw new HalowrightError("invalid_locator", why); };
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail("locator must be an object");
    const spec = value;
    const keys = Object.keys(spec);
    const forms = ["role", "label", "text", "placeholder", "testid"].filter((key) => key in spec);
    if (forms.length !== 1)
        return fail("exactly one of role, label, text, placeholder, testid");
    const allowed = new Set([forms[0], "nth", ...(forms[0] === "role" ? ["name"] : []), ...(nested ? [] : ["within"])]);
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
    const within = "within" in spec ? { within: validateLocator(spec.within, true) } : {};
    if (forms[0] === "role") {
        const role = str("role");
        if (!ROLES.includes(role))
            return fail("unsupported role");
        return { role, ...("name" in spec ? { name: str("name") } : {}), ...nth, ...within };
    }
    return { [forms[0]]: str(forms[0]), ...nth, ...within };
}
// Runs in the isolated world and returns a ResolveResult as JSON.
function locatorResolveSource(spec, settle = false) {
    return `((spec, settle) => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const IMPLICIT = { button: "button,[role=button],input[type=button],input[type=submit]", link: "a[href],[role=link]", textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=url],input[type=tel],input[type=password],textarea,[role=textbox]", checkbox: "input[type=checkbox],[role=checkbox]", radio: "input[type=radio],[role=radio]", combobox: "select,[role=combobox]", heading: "h1,h2,h3,h4,h5,h6,[role=heading]", tab: "[role=tab]", menuitem: "[role=menuitem]", option: "option,[role=option]", switch: "[role=switch]" };
    // A wrapping <label> also contains its control and options; only its own words name the control.
    const labelText = (l) => { const c = l.cloneNode(true); c.querySelectorAll("select,textarea,input,option,button").forEach((n) => n.remove()); return c.textContent; };
    const nameOf = (el) => norm(el.getAttribute("aria-label") || (el.labels && el.labels[0] && labelText(el.labels[0])) || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder"));
    // Open shadow roots are searched too; a closed root is invisible to any script, so it is never matched.
    const qsa = (root, sel) => { const out = [...root.querySelectorAll(sel)]; for (const h of root.querySelectorAll("*")) if (h.shadowRoot) out.push(...qsa(h.shadowRoot, sel)); return out; };
    const find = (s, root) => {
      let found = [];
      if (s.role) found = qsa(root, IMPLICIT[s.role]).filter((el) => s.name === undefined || nameOf(el) === norm(s.name));
      else if (s.label) found = qsa(root, "input,textarea,select").filter((el) => (el.labels && [...el.labels].some((l) => norm(labelText(l)) === norm(s.label))) || norm(el.getAttribute("aria-label")) === norm(s.label));
      else if (s.placeholder) found = qsa(root, "[placeholder]").filter((el) => norm(el.getAttribute("placeholder")) === norm(s.placeholder));
      else if (s.testid) found = qsa(root, "[data-testid]").filter((el) => el.getAttribute("data-testid") === s.testid);
      else if (s.text) found = qsa(root, "*").filter((el) => el.children.length === 0 && norm(el.innerText || el.textContent) === norm(s.text));
      const shown = found.filter((el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; });
      return shown.length > 0 ? shown : found;
    };
    let scope = document;
    if (spec.within) {
      const containers = find(spec.within, document);
      if (containers.length === 0) return JSON.stringify({ status: "not_found" });
      if (containers.length > 1 && spec.within.nth === undefined) return JSON.stringify({ status: "ambiguous", count: containers.length, candidates: containers.slice(0, 5).map((c) => c.tagName.toLowerCase() + (c.id ? "#" + c.id : "")) });
      const container = containers[spec.within.nth === undefined ? 0 : spec.within.nth];
      if (!container) return JSON.stringify({ status: "not_found" });
      // A text or label match is a leaf; the scope is the smallest ancestor-or-self that actually holds a match of the inner locator.
      scope = container;
      for (let up = 0; up < 8 && scope && find(spec, scope).length === 0; up++) scope = scope.parentElement || (scope.getRootNode && scope.getRootNode().host) || null;
      if (!scope) return JSON.stringify({ status: "not_found" });
    }
    let list = find(spec, scope);
    const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ":" + nameOf(el).slice(0, 40);
    if (list.length === 0) return JSON.stringify({ status: "not_found" });
    const index = spec.nth === undefined ? (list.length === 1 ? 0 : -1) : spec.nth;
    if (index === -1) return JSON.stringify({ status: "ambiguous", count: list.length, candidates: list.slice(0, 5).map(label) });
    const el = list[index];
    if (!el) return JSON.stringify({ status: "not_found" });
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const probe = () => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") return { status: "not_actionable", reason: "hidden" };
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return { status: "not_actionable", reason: "disabled" };
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      let top = document.elementFromPoint(x, y);
      for (let inner; top && top.shadowRoot && (inner = top.shadowRoot.elementFromPoint(x, y)) && inner !== top;) top = inner;
      if (!top || !(top === el || el.contains(top) || top.contains(el))) return { status: "not_actionable", reason: "covered" };
      const checked = typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true" ? true : el.getAttribute("aria-checked") === "false" ? false : undefined;
      // Halo: hw_step authorizes the resolved element, not the locator string,
      // so carry the element's role/name/input type for the host's runtime gate.
      const inputType = el.tagName === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : undefined;
      return { status: "resolved", x, y, tag: el.tagName, role: el.getAttribute("role") || el.tagName.toLowerCase(), name: String(nameOf(el)).slice(0, 120), ...(inputType === undefined ? {} : { inputType }), ...(checked === undefined ? {} : { checked }), ...(el.getAttribute("aria-selected") === "true" ? { selected: true } : {}) };
    };
    const first = probe();
    if (!settle || first.status !== "resolved") return JSON.stringify(first);
    // One frame later the same element must sit at the same point; a hidden page never paints, so a timer backs the frame up.
    return new Promise((done) => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; const second = probe(); done(JSON.stringify(second.status === "resolved" && second.x === first.x && second.y === first.y ? { ...second, stable: true } : second)); };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 60);
    });
  })(${JSON.stringify(spec)}, ${settle ? "true" : "false"})`;
}
async function waitForActionable({ resolve, spec, sleep, timeoutMs = 5000, intervalMs = 100, settleMs = 32 }) {
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
            // The page already re-read the position one frame later and found it unchanged.
            if (current.stable)
                return { ...current, waitedMs: waited };
            if (previous && previous.x === current.x && previous.y === current.y)
                return { ...current, waitedMs: waited };
            previous = { x: current.x, y: current.y };
        }
        else
            previous = null;
        if (waited >= timeoutMs)
            break;
        const gap = previous ? Math.min(settleMs, intervalMs) : intervalMs;
        await sleep(gap);
        waited += gap;
    }
    return last.status === "resolved" ? { status: "not_actionable", reason: "moving", waitedMs: waited } : { ...last, waitedMs: waited };
}
module.exports = { HalowrightError, validateLocator, locatorResolveSource, waitForActionable };
