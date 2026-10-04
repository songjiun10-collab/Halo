// Generated from runtime-src/main/harness/activity-journal.ts. Do not edit; run npm run build:runtime.
"use strict";
const MAX_TITLE = 200;
const MAX_EXCERPT = 600;
const MAX_ENTRIES = 300;
const RETENTION_DAYS = 14;
const SAME_PAGE_WINDOW_MS = 30 * 60 * 1000;
const RECALL_LIMIT = 5;
const RECALL_BUDGET_BYTES = 2500;
// Hosts and paths that can show credentials, money, private mail or an account.
const SENSITIVE_HOST = /paypal|stripe|1password|lastpass|bitwarden|dashlane|bank|mail|outlook|login|signin|wallet|payment|(^|[.-])(auth|accounts?|pay|secure)([.-]|$)/i;
const SENSITIVE_PATH = /\/(log-?in|sign-?in|sign-?up|auth|oauth|password|passwd|checkout|payment|billing|wallet|account|settings\/security)(\/|$)/i;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.localhost|.*\.test|.*\.internal)$/i;
const IP_HOST = /^\d{1,3}(\.\d{1,3}){3}$|^\[.*\]$/;
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "and", "or", "is", "are", "that", "this", "me", "my", "i", "it", "for", "with", "what", "about", "find", "show", "summarize"]);
const clean = (value, max) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
function pageKey(value) {
    if (typeof value !== "string")
        return null;
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
        return null;
    const host = parsed.hostname;
    if (PRIVATE_HOST.test(host) || IP_HOST.test(host) || SENSITIVE_HOST.test(host) || SENSITIVE_PATH.test(parsed.pathname))
        return null;
    return { url: parsed.origin + parsed.pathname, origin: parsed.origin };
}
// null means "do not record this visit".
function makeEntry(input, id) {
    if (input.hasSensitiveField)
        return null;
    const key = pageKey(input.url);
    if (!key)
        return null;
    const title = clean(input.title, MAX_TITLE);
    const excerpt = clean(input.excerpt, MAX_EXCERPT);
    if (!title && !excerpt)
        return null;
    return { id, url: key.url, origin: key.origin, title, excerpt, visitedAt: input.at };
}
// Fold a visit into the journal: a revisit of the same page within a short
// window refreshes that entry; old and surplus entries are dropped.
function addEntry(entries, entry) {
    const at = Date.parse(entry.visitedAt);
    const kept = entries.filter((existing) => !(existing.url === entry.url && at - Date.parse(existing.visitedAt) < SAME_PAGE_WINDOW_MS));
    return prune([...kept, entry], entry.visitedAt);
}
function prune(entries, now) {
    const cutoff = Date.parse(now) - RETENTION_DAYS * 86_400_000;
    return entries.filter((entry) => Date.parse(entry.visitedAt) >= cutoff)
        .sort((a, b) => a.visitedAt.localeCompare(b.visitedAt))
        .slice(-MAX_ENTRIES);
}
function tokens(query) {
    return [...new Set(query.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2 && !STOP.has(token)))];
}
// Relevant past pages for a request, best first, within a small byte budget.
// A page is only returned if the request shares a word with it.
function recall(entries, query, limit = RECALL_LIMIT, budgetBytes = RECALL_BUDGET_BYTES) {
    const words = tokens(query);
    if (words.length === 0)
        return [];
    const scored = entries.map((entry) => {
        const title = entry.title.toLowerCase();
        const body = entry.excerpt.toLowerCase();
        const titleWords = new Set(title.split(/[^\p{L}\p{N}]+/u));
        const bodyWords = new Set(body.split(/[^\p{L}\p{N}]+/u));
        // A short ASCII word only counts as a whole word ("at" is not "water").
        const has = (text, set, word) => /^[\x00-\x7f]{1,3}$/.test(word) ? set.has(word) : text.includes(word);
        let score = 0;
        for (const word of words) {
            if (has(title, titleWords, word))
                score += 3;
            if (has(body, bodyWords, word))
                score += 1;
        }
        return { entry, score };
    }).filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.visitedAt.localeCompare(a.entry.visitedAt));
    const out = [];
    let bytes = 0;
    for (const { entry } of scored.slice(0, limit)) {
        const text = `Visited ${entry.visitedAt.slice(0, 10)}: ${entry.title || entry.url} (${entry.url})${entry.excerpt ? ` — ${entry.excerpt}` : ""}`;
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > budgetBytes)
            break;
        out.push({ id: `activity-${entry.id}`, text, origin: entry.origin });
    }
    return out;
}
module.exports = { MAX_ENTRIES, RETENTION_DAYS, MAX_EXCERPT, pageKey, makeEntry, addEntry, prune, recall };
