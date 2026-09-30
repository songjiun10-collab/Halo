"use strict";

const { matchingAllowedDomain, normalizeDomain, normalizeAllowlistEntry } = require("./domain-utils");

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

module.exports = { cookieToElectron, injectSessions };
