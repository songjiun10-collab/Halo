"use strict";

// Reads the text layer of a PDF the agent's page shows. Chromium's PDF viewer
// exposes nothing to the page scripts, so the observation of a PDF tab is
// empty and the planner reports "the PDF is blank". This fetches the same URL
// through the page's own session (cookies included), checks it really is a PDF
// before parsing, and returns plain text.
//
// Plain JS on purpose: pdfjs-dist ships ESM only, and the TypeScript harness
// cohort compiles to CommonJS, which would turn the dynamic import() into a
// require().
//
// Scanned PDFs have no text layer; that case returns { text: "", scanned: true }
// and is the hook for OCR, which is not implemented yet.

const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_PAGES = 60;
const FETCH_TIMEOUT_MS = 20_000;
const PDF_MAGIC = "%PDF-";

let pdfjsPromise = null;
function loadPdfjs() {
  // Resolved lazily so a missing optional dependency only disables PDF reading.
  pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function looksLikePdfUrl(url) {
  try { return new URL(url).pathname.toLowerCase().endsWith(".pdf"); } catch { return false; }
}

function isFetchableUrl(url) {
  try { const { protocol } = new URL(url); return protocol === "https:" || protocol === "http:"; } catch { return false; }
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}

// -> { pages: [{ page, text }], pageCount, scanned } or null when the URL is not a readable PDF.
async function extractPdfText(url, { fetchImpl, maxBytes = MAX_PDF_BYTES, maxPages = MAX_PAGES, signal } = {}) {
  if (!isFetchableUrl(url) || typeof fetchImpl !== "function") return null;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response?.ok) return null;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("pdf") && !looksLikePdfUrl(url) && !contentType.includes("octet-stream")) {
    await response.body?.cancel?.().catch(() => {});
    return null;
  }
  const bytes = await readBounded(response, maxBytes);
  if (!bytes || bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) return null;

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages = [];
    const count = Math.min(doc.numPages, maxPages);
    for (let number = 1; number <= count; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      pages.push({ page: number, text });
      page.cleanup();
    }
    const scanned = pages.every((entry) => entry.text.length === 0);
    return { pages, pageCount: doc.numPages, scanned };
  } finally {
    await task.destroy();
  }
}

// Fits the extracted pages into one observation's text budget, in page order,
// and says where it stopped so the planner can ask for the rest.
function formatPdfObservationText(result, { maxBytes, startPage = 1 } = {}) {
  if (!result) return "";
  if (result.scanned) return `[PDF with ${result.pageCount} pages: no text layer (scanned images); OCR is not available]`;
  const parts = [];
  let used = 0;
  let last = startPage - 1;
  for (const { page, text } of result.pages) {
    if (page < startPage || !text) continue;
    const block = `[page ${page}] ${text}`;
    const size = Buffer.byteLength(block, "utf8");
    if (used + size > maxBytes) {
      if (!parts.length) { parts.push(block.slice(0, Math.max(0, maxBytes - 64))); last = page; }
      break;
    }
    parts.push(block);
    used += size + 1;
    last = page;
  }
  const tail = last < result.pageCount ? ` [PDF text shown through page ${last} of ${result.pageCount}]` : "";
  return parts.join("\n") + tail;
}

module.exports = { extractPdfText, formatPdfObservationText, looksLikePdfUrl, MAX_PDF_BYTES, MAX_PAGES };
