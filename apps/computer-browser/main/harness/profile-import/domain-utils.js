"use strict";

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeDomain(value) {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/^\./, "");
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

function domainMatches(cookieDomain, allowlist) {
  const host = normalizeDomain(cookieDomain);
  if (!host) return false;
  return allowlist.some((entry) => {
    const allowed = normalizeDomain(entry);
    return allowed !== null && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function matchingAllowedDomain(cookieDomain, allowlist) {
  const host = normalizeDomain(cookieDomain);
  if (!host) return null;
  for (const entry of allowlist) {
    const allowed = normalizeDomain(entry);
    if (allowed !== null && (host === allowed || host.endsWith(`.${allowed}`))) return allowed;
  }
  return null;
}

module.exports = { normalizeDomain, domainMatches, matchingAllowedDomain };
