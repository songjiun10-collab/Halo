"use strict";

// Text computer use: a planner with no image input gets a deterministic
// "screen map" instead of a screenshot. Geometry comes from the host-owned
// isolated-world node bindings (never from page-supplied text), is normalized
// to the viewport, and is reduced to the plain-text lines below. The map is
// page-derived data for the planner to read, never an instruction.

interface ObservedElement { elementId: string; role?: string; name?: string; disabled?: boolean; inputType?: string }
interface ElementGeometry { elementId: string; x: number; y: number; w: number; h: number; covered?: boolean }
interface ScreenMapOptions { maxEntries?: number; maxBytes?: number }
interface ScreenTarget { role: string; name: string; x: number; y: number; w: number; h: number; covered: boolean; disabled: boolean }
interface ScreenMap { text: string; entries: number; actionable: number; sparse: boolean; targets: ScreenTarget[] }

const MAX_ENTRIES = 80;
const MAX_BYTES = 8 * 1024;
const MAX_NAME_CHARS = 60;
// Roles a coordinate click can usefully land on.
const ACTIONABLE = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "textbox", "searchbox", "combobox", "listbox", "option", "slider"]);
// Fewer actionable targets than this, and the page is probably canvas/image
// driven, where a text map is a weak substitute for seeing the screen.
const SPARSE_BELOW = 2;

const unit = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const fixed = (value: number): string => value.toFixed(3);
const clean = (value: unknown): string => String(value ?? "").replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);

function buildScreenMap(elements: readonly ObservedElement[], geometry: readonly ElementGeometry[], { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }: ScreenMapOptions = {}): ScreenMap {
  const byId = new Map(elements.map((element) => [element.elementId, element]));
  const lines: string[] = [];
  const targets: ScreenTarget[] = [];
  let bytes = 0;
  let actionable = 0;
  for (const box of geometry) {
    const element = byId.get(box?.elementId);
    const x = unit(box?.x), y = unit(box?.y), w = unit(box?.w), h = unit(box?.h);
    if (!element || x === null || y === null || w === null || h === null || w === 0 || h === 0) continue;
    // Center, clamped into the half-open [0,1) range the coordinate actions accept.
    const cx = Math.min(x + w / 2, 0.999), cy = Math.min(y + h / 2, 0.999);
    const role = clean(element.role) || "element";
    const isActionable = ACTIONABLE.has(role) && !element.disabled && !box.covered;
    const flags = [element.disabled ? "disabled" : "", box.covered ? "covered" : "", element.inputType ? `type=${clean(element.inputType)}` : ""].filter(Boolean).join(",");
    const line = `${role} "${clean(element.name)}" at ${fixed(cx)},${fixed(cy)} size ${fixed(w)}x${fixed(h)}${flags ? ` [${flags}]` : ""}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (lines.length >= maxEntries || bytes + lineBytes > maxBytes) break;
    lines.push(line);
    targets.push({ role, name: clean(element.name), x, y, w, h, covered: !!box.covered, disabled: !!element.disabled });
    bytes += lineBytes;
    if (isActionable) actionable += 1;
  }
  return { text: lines.join("\n"), entries: lines.length, actionable, sparse: actionable < SPARSE_BELOW, targets };
}

const EPS = 1e-9;

// Host-side only: which mapped control a coordinate action lands on. The smallest
// box containing the point wins, so a button inside a card beats the card. A
// covered or disabled hit is still reported (with its flags) rather than hidden.
function resolveTarget(targets: readonly ScreenTarget[], x: number, y: number): ScreenTarget | null {
  let best: ScreenTarget | null = null;
  for (const t of targets) {
    if (x + EPS < t.x || x > t.x + t.w + EPS || y + EPS < t.y || y > t.y + t.h + EPS) continue;
    if (!best || t.w * t.h < best.w * best.h) best = t;
  }
  return best;
}

export = { MAX_ENTRIES, MAX_BYTES, buildScreenMap, resolveTarget };
