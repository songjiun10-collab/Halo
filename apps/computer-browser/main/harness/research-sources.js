"use strict";

// Host side of source-grounded research. The model writes the answer; the host decides which
// sources it may cite: only pages the host itself opened and observed during this task. An answer
// that cites a page nobody opened, or too few independent sites, is sent back before the person
// reads it. The host also appends its own source list, so provenance never rests on the model's word.

const { getDomain } = require("tldts");

const MAX_LEDGER = 60;
const MAX_URL = 2048;
const MAX_TITLE = 160;
const MIN_SOURCES = 2;
const MIN_DOMAINS = 2;
const MAX_REJECTIONS = 2;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref|spm)$/i;

// A page identity that survives http/https, "www.", fragments, a trailing slash and tracking parameters.
function normalizeUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const params = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "";
  return `${host}${url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : ""}${path}${query}`;
}

function domainOf(value) {
  try { return getDomain(new URL(value).hostname, { allowPrivateDomains: false }) ?? new URL(value).hostname.toLowerCase(); } catch { return null; }
}

// URLs written in an answer. Hangul and closing punctuation end a URL, which matters in Korean text.
function extractCitedUrls(text) {
  if (typeof text !== "string") return [];
  const found = [];
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"'<ㄱ-ㆎ가-힣…]+/gi)) {
    const url = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    if (normalizeUrl(url) && !found.includes(url)) found.push(url);
  }
  return found;
}

class SourceLedger {
  constructor(entries = []) {
    this._byKey = new Map();
    for (const entry of entries) this.add(entry);
  }

  // Only a host-observed page counts. Returns true when it was new.
  add({ url, title = "", at = Date.now() }) {
    const key = normalizeUrl(url);
    if (!key || this._byKey.has(key)) return false;
    if (this._byKey.size >= MAX_LEDGER) this._byKey.delete(this._byKey.keys().next().value);
    this._byKey.set(key, { url: String(url).slice(0, MAX_URL), title: String(title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE), at: Number.isFinite(at) ? at : Date.now() });
    return true;
  }

  find(url) {
    const key = normalizeUrl(url);
    return key ? this._byKey.get(key) ?? null : null;
  }

  list() { return [...this._byKey.values()]; }
  get size() { return this._byKey.size; }
}

// reasons: "no_sources" (nothing cited), "unverified_source" (cited a page that was never opened),
// "too_few_sources" (fewer than minDomains independent sites among the verified ones).
function checkAnswer(text, ledger, { minDomains = MIN_DOMAINS } = {}) {
  const cited = extractCitedUrls(text);
  const verified = [];
  const unverified = [];
  for (const url of cited) {
    const hit = ledger.find(url);
    if (hit) { if (!verified.some((v) => normalizeUrl(v.url) === normalizeUrl(hit.url))) verified.push(hit); }
    else unverified.push(url);
  }
  const domains = new Set(verified.map((v) => domainOf(v.url)).filter(Boolean));
  const reasons = [];
  if (cited.length === 0) reasons.push("no_sources");
  if (unverified.length > 0) reasons.push("unverified_source");
  if (cited.length > 0 && domains.size < minDomains) reasons.push("too_few_sources");
  return { ok: reasons.length === 0, reasons, verified, unverified, cited, independentSites: domains.size };
}

function stamp(at) {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
}

// The host's own list, appended after the model's answer.
function sourcesBlock(verified) {
  if (!verified.length) return "";
  const lines = verified.slice(0, 8).map((v, i) => `${i + 1}. ${v.title ? `${v.title} - ` : ""}${v.url} (opened ${stamp(v.at)})`);
  return `\n\nSources Halo opened (host-verified):\n${lines.join("\n")}`;
}

// Used after the rejection limit: the answer still reaches the person, clearly marked.
function unverifiedNotice(check) {
  const parts = [];
  if (check.reasons.includes("no_sources")) parts.push("it cites no source");
  if (check.unverified.length) parts.push(`it cites ${check.unverified.length} page${check.unverified.length === 1 ? "" : "s"} Halo never opened`);
  if (check.reasons.includes("too_few_sources")) parts.push(`fewer than ${MIN_DOMAINS} independent sites were verified`);
  return `\n\n[Not verified by Halo: ${parts.join("; ")}. Treat these claims as unchecked.]`;
}

module.exports = { normalizeUrl, domainOf, extractCitedUrls, SourceLedger, checkAnswer, sourcesBlock, unverifiedNotice, MIN_SOURCES, MIN_DOMAINS, MAX_REJECTIONS, MAX_LEDGER };
