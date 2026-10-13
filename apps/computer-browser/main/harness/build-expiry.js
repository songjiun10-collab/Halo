"use strict";

// Beta builds can carry an expiry date so an old build does not keep running after a newer one
// ships. The packaging step writes build-info.json next to the app; a development checkout has
// none and never expires. This is a courtesy and an incident-response tool, not a security
// control: it trusts the system clock, and anyone with the files can delete the file.

const fs = require("node:fs");

const DAY_MS = 86_400_000;

// "2027-02-28" means the end of that day (UTC); a full ISO timestamp is taken as given.
function parseExpiry(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    // Reject 2027-02-31 style dates that Date would silently roll over.
    return validDate(y, m, d) ? Date.UTC(y, m - 1, d + 1) - 1 : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

function validDate(y, m, d) {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// A missing file is a development build (no expiry). A file that exists but cannot be read or
// has no usable date fails closed: the build is treated as expired rather than as unlimited.
function readBuildInfo(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { return error?.code === "ENOENT" ? { expiresAt: null, invalid: false } : { expiresAt: null, invalid: true }; }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { expiresAt: null, invalid: true };
    if (parsed.expiresAt === undefined || parsed.expiresAt === null) return { expiresAt: null, invalid: false };
    const at = parseExpiry(parsed.expiresAt);
    return at === null ? { expiresAt: null, invalid: true } : { expiresAt: at, invalid: false };
  } catch { return { expiresAt: null, invalid: true }; }
}

// info: { expiresAt: number | null, invalid: boolean }
function checkBuild(info, now = Date.now()) {
  if (!info) return { expired: false, daysLeft: null, expiresAt: null };
  if (info.invalid) return { expired: true, daysLeft: 0, expiresAt: null, invalid: true };
  if (info.expiresAt === null || info.expiresAt === undefined) return { expired: false, daysLeft: null, expiresAt: null };
  const left = info.expiresAt - now;
  return { expired: left < 0, daysLeft: Math.max(0, Math.ceil(left / DAY_MS)), expiresAt: info.expiresAt };
}

module.exports = { parseExpiry, readBuildInfo, checkBuild, DAY_MS };
