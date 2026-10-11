"use strict";

// PageAgent-style observation outline, adapted to Halo's host-owned model.
//
// PageAgent (github.com/alibaba/page-agent, MIT) renders the page as an indexed
// tree — `[index]<tag>text</tag>` with tab indentation, `*[` marking elements
// that appeared since the last step, and `data-scrollable` distances — and lets
// the model act only on those indexes. This module ports the *format* of that
// observation into Halo: pure formatting over the host-owned element list and
// normalized geometry the adapter already produces. It executes nothing in the
// page and changes no policy, gate or approval behaviour.
//
// Why it exists next to screen-map.js: screen-map is a flat coordinate list.
// This adds (a) a stable `[elementId]` index prefix, (b) `*` new-since-last
// observation markers for dynamic pages, (c) optional tab indentation when the
// caller supplies `depth`, and (d) optional scrollable distances. Callers pass
// the previous call's `signatures` to get the markers; nothing is stored here.
//
// Lines carry ONLY what elements does not already carry for the same
// elementId: coordinates, nesting, newness and state flags. Role and name are
// deliberately absent -- the planner looks the elementId up in
// context.observation.elements instead. Measured (2026-10-09): role+name were
// 3.4 KB per heavy-page turn, over half the outline's bytes.
//
// Output is bounded exactly like screen-map: MAX_ENTRIES lines / MAX_BYTES
// utf8 bytes, coordinates rounded to 3 decimals.

const MAX_ENTRIES = 80;
const MAX_BYTES = 8 * 1024;
const MAX_NAME_CHARS = 60;
const MAX_SCROLL_PX = 10_000_000;
// Roles a coordinate click can usefully land on (same set as screen-map).
const ACTIONABLE = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "textbox", "searchbox", "combobox", "listbox", "option", "slider"]);

const unit = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const fixed = (value) => value.toFixed(3);
const clean = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
const scrollPx = (value) => (Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), MAX_SCROLL_PX) : 0);

// Identity of a rendered control. Two observations of "the same control" match
// only when role, name and normalized bounds all match, so a moved or renamed
// control is honestly reported as new rather than silently reused.
function signatureOf(element, box) {
  return `${clean(element.role)}\u0000${clean(element.name)}\u0000${fixed(box.x)},${fixed(box.y)},${fixed(box.w)},${fixed(box.h)}`;
}

function buildDomOutline(elements, geometry, { previousSignatures = null, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  const byId = new Map(elements.map((element) => [element.elementId, element]));
  const previous = previousSignatures ? new Set(previousSignatures) : null;
  const lines = [];
  const targets = [];
  const signatures = [];
  let bytes = 0;
  let actionable = 0;
  for (const box of geometry) {
    const element = byId.get(box?.elementId);
    const x = unit(box?.x), y = unit(box?.y), w = unit(box?.w), h = unit(box?.h);
    if (!element || x === null || y === null || w === null || h === null || w === 0 || h === 0) continue;
    const cx = Math.min(x + w / 2, 0.999), cy = Math.min(y + h / 2, 0.999);
    const role = clean(element.role) || "element";
    const isActionable = ACTIONABLE.has(role) && !element.disabled && !box.covered;
    const signature = signatureOf(element, { x, y, w, h });
    const isNew = previous !== null && !previous.has(signature);
    const depth = Number.isInteger(element.depth) && element.depth >= 0 ? Math.min(element.depth, 12) : 0;
    const flags = [
      element.disabled ? "disabled" : "",
      box.covered ? "covered" : "",
      element.inputType ? `type=${clean(element.inputType)}` : "",
    ].filter(Boolean).join(",");
    const scroll = element.scrollable && typeof element.scrollable === "object"
      ? [["up", scrollPx(element.scrollable.up)], ["down", scrollPx(element.scrollable.down)], ["left", scrollPx(element.scrollable.left)], ["right", scrollPx(element.scrollable.right)]]
          .filter(([, px]) => px > 0).map(([dir, px]) => `${dir}:${px}`).join(",")
      : "";
    const line = `${isNew ? "*" : ""}[${element.elementId}] ${"\t".repeat(depth)}at ${fixed(cx)},${fixed(cy)} size ${fixed(w)}x${fixed(h)}${flags ? ` [${flags}]` : ""}${scroll ? ` scrollable=[${scroll}]` : ""}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (lines.length >= maxEntries || bytes + lineBytes > maxBytes) break;
    lines.push(line);
    targets.push({ role, name: clean(element.name), x, y, w, h, covered: !!box.covered, disabled: !!element.disabled });
    signatures.push(signature);
    bytes += lineBytes;
    if (isActionable) actionable += 1;
  }
  return { text: lines.join("\n"), entries: lines.length, actionable, sparse: actionable < 2, targets, signatures };
}

const EPS = 1e-9;
// Same hit-test contract as screen-map.resolveTarget: the smallest containing box wins.
function resolveOutlineTarget(targets, x, y) {
  let best = null;
  for (const target of targets) {
    if (x + EPS < target.x || x > target.x + target.w + EPS || y + EPS < target.y || y > target.y + target.h + EPS) continue;
    if (!best || target.w * target.h < best.w * best.h) best = target;
  }
  return best;
}

module.exports = { MAX_ENTRIES, MAX_BYTES, ACTIONABLE, buildDomOutline, resolveOutlineTarget, signatureOf };
