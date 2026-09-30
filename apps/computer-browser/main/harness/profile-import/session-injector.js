"use strict";

const { domainMatches, matchingAllowedDomain, normalizeDomain, normalizeAllowlistEntry } = require("./domain-utils");

const SAME_SITE = { lax: "lax", strict: "strict", none: "no_restriction", unspecified: "unspecified" };

function cookieToElectron(cookie) {
  const host = normalizeDomain(cookie.domain);
  const details = {
    url: `https://${host}/`, name: cookie.name, value: cookie.value, path: cookie.path || "/",
    secure: true, httpOnly: Boolean(cookie.httpOnly), sameSite: SAME_SITE[cookie.sameSite] || "unspecified",
  };
  if (cookie.domain.startsWith(".")) details.domain = cookie.domain;
  if (typeof cookie.expires === "number") details.expirationDate = cookie.expires;
  return details;
}

async function injectSessions({ vault, session, domains, nowSeconds = Date.now() / 1000 }) {
  const allowlist = (Array.isArray(domains) ? domains : []).map(normalizeAllowlistEntry).filter(Boolean);
  if (!allowlist.length) return { injected: 0, failed: 0, domains: [] };
  const cookies = await vault.cookiesFor({ domains: allowlist, nowSeconds });
  let injected = 0;
  let failed = 0;
  const covered = new Set();
  for (const cookie of cookies) {
    try {
      await session.cookies.set(cookieToElectron(cookie));
      injected += 1;
      covered.add(matchingAllowedDomain(cookie.domain, allowlist));
    } catch {
      failed += 1;
    }
  }
  return { injected, failed, domains: allowlist.filter((d) => covered.has(d)) };
}

async function removeCookiesWhere(session, shouldRemove) {
  if (typeof session?.cookies?.get !== "function" || typeof session?.cookies?.remove !== "function") {
    throw new TypeError("session cookie removal is unavailable");
  }
  const cookies = await session.cookies.get({});
  const matched = cookies.filter((cookie) => {
    const host = normalizeDomain(cookie.domain);
    return host && shouldRemove(host);
  });
  for (const cookie of matched) {
    const host = normalizeDomain(cookie.domain);
    const cookiePath = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
    const url = `${cookie.secure ? "https" : "http"}://${host}${cookiePath}`;
    try { await session.cookies.remove(url, cookie.name); } catch { /* final read is authoritative */ }
  }
  const remaining = await session.cookies.get({});
  const stillPresent = remaining.reduce((count, cookie) => {
    const host = normalizeDomain(cookie.domain);
    return count + (host && shouldRemove(host) ? 1 : 0);
  }, 0);
  return { removed: Math.max(matched.length - stillPresent, 0), failed: stillPresent };
}

async function clearSessionCookies(session, domains) {
  const allowlist = (Array.isArray(domains) ? domains : []).map(normalizeDomain).filter(Boolean);
  if (!allowlist.length) return { removed: 0, failed: 0 };
  return removeCookiesWhere(session, (host) => domainMatches(host, allowlist));
}

async function clearDisallowedSessionCookies(session, allowedDomains) {
  const allowlist = (Array.isArray(allowedDomains) ? allowedDomains : []).map(normalizeDomain).filter(Boolean);
  return removeCookiesWhere(session, (host) => !domainMatches(host, allowlist));
}

module.exports = { cookieToElectron, injectSessions, clearSessionCookies, clearDisallowedSessionCookies };
