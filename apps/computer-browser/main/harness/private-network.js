"use strict";

// Addresses on the person's own computer or network: loopback, private and link-local ranges, and
// names that only resolve inside a home or company network (router pages, NAS boxes, local dev
// servers, intranet tools, the cloud metadata address). An agent page opens one only when the
// person named it; a page cannot send the agent there. A public name that resolves to a private
// address (DNS rebinding) is not caught here.

const LOCAL_SUFFIXES = Object.freeze([".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"]);
const MAX_NAMED_ORIGINS = 16;

function ipv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function privateIpv4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

// The URL parser has already written IPv6 in its short form ([::ffff:7f00:1]); read it back as eight numbers.
function ipv6(host) {
  if (!host.startsWith("[") || !host.endsWith("]")) return null;
  const halves = host.slice(1, -1).split("::");
  if (halves.length > 2) return null;
  const read = (part) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : NaN)));
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array(missing).fill(0), ...tail];
  return groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function privateIpv6(groups) {
  // ::, ::1 and the old IPv4-compatible form.
  if (groups.slice(0, 6).every((group) => group === 0)) return true;
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is judged as that IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return privateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}

/** hostname as URL.hostname gives it (lowercase, IPv4 normalised, IPv6 in brackets). */
function isPrivateHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") return false;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4);
  if (host.startsWith("[")) {
    const v6 = ipv6(host);
    // An address that cannot be read is never assumed to be public.
    return v6 ? privateIpv6(v6) : true;
  }
  // A name without a dot (http://router/) only resolves inside the local network.
  if (host === "localhost" || !host.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// URLs are read as plain ASCII URL characters, so Korean text right after one
// (localhost:3000에서) ends it instead of making it unreadable.
const URL_IN_TEXT = /\bhttps?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const BARE_HOST = /(?<![\w.:/@-])((?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:localhost|local|localdomain|internal|lan|home\.arpa)|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?)(?![\w-])/gi;

/** The private origins a piece of text names itself, with or without http:// (then both http and https). */
function privateOriginsNamedIn(text) {
  if (typeof text !== "string" || text === "") return [];
  const origins = new Set();
  const add = (candidate) => {
    if (origins.size >= MAX_NAMED_ORIGINS) return;
    let url;
    try { url = new URL(candidate); } catch { return; }
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && isPrivateHost(url.hostname)) origins.add(url.origin);
  };
  for (const [match] of text.matchAll(URL_IN_TEXT)) add(match.replace(/[.,;:!?)\]}]+$/, ""));
  for (const [, named] of text.replace(URL_IN_TEXT, " ").matchAll(BARE_HOST)) {
    add(`http://${named}`);
    add(`https://${named}`);
  }
  return [...origins];
}

module.exports = { isPrivateHost, privateOriginsNamedIn };
