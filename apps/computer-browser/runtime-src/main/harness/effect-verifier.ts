"use strict";

// After a write action (Enter, click, typed text) the host looks at the page
// again and only calls the action "ok" when something it can measure changed.
// The measurement is the host's own; nothing the agent says about the result is used.

interface PageSnapshot { url: string; title: string; nodes: number; textLength: number; focus: string; valueLength: number }
interface EffectResult { observed: boolean; changed: string[] }
interface VerifyOptions {
  before: PageSnapshot;
  read: () => Promise<PageSnapshot | null>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

const FIELDS: readonly (keyof PageSnapshot)[] = ["url", "title", "nodes", "textLength", "focus", "valueLength"];

// Runs in the isolated world. Returns a JSON string so the value crosses the boundary unchanged.
const PAGE_SNAPSHOT_SOURCE = `(() => {
  const a = document.activeElement;
  const focus = a && a !== document.body ? a.tagName + (a.id ? "#" + a.id : a.getAttribute("name") ? "[" + a.getAttribute("name") + "]" : "") : "";
  const valueLength = a && typeof a.value === "string" ? a.value.length : -1;
  return JSON.stringify({
    url: location.href, title: document.title,
    nodes: document.getElementsByTagName("*").length,
    textLength: (document.body && document.body.innerText || "").length,
    focus, valueLength,
  });
})()`;

function parseSnapshot(raw: unknown): PageSnapshot | null {
  if (typeof raw !== "string") return null;
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const ok = typeof value.url === "string" && typeof value.title === "string" && typeof value.focus === "string"
    && Number.isFinite(value.nodes) && Number.isFinite(value.textLength) && Number.isFinite(value.valueLength);
  return ok ? { url: value.url, title: value.title, nodes: value.nodes, textLength: value.textLength, focus: value.focus, valueLength: value.valueLength } : null;
}

function diffSnapshots(before: PageSnapshot, after: PageSnapshot): string[] {
  return FIELDS.filter((field) => before[field] !== after[field]);
}

async function verifyEffect({ before, read, sleep, timeoutMs = 1500, intervalMs = 100 }: VerifyOptions): Promise<EffectResult> {
  // Input may already have taken effect by the time CDP returns. Read once
  // without a fixed delay, then retain every original delayed poll below.
  // A missing/failed read is not evidence of success.
  const immediate = await read().catch(() => null);
  if (immediate) {
    const changed = diffSnapshots(before, immediate);
    if (changed.length > 0) return { observed: true, changed };
  }
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await sleep(intervalMs);
    const after = await read().catch(() => null);
    if (!after) continue;
    const changed = diffSnapshots(before, after);
    if (changed.length > 0) return { observed: true, changed };
  }
  return { observed: false, changed: [] };
}

export = { PAGE_SNAPSHOT_SOURCE, parseSnapshot, diffSnapshots, verifyEffect };
