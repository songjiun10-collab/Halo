"use strict";

const { getDomain } = require("tldts");

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeDomain(value) {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/^\./, "");
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

// An allowlist entry must be a registrable domain: a public suffix such as
// "co.uk" or a private one such as "github.io" would otherwise select the
// cookies of every unrelated site beneath it. Private suffixes are honored, so
// "user.github.io" is registrable while "github.io" is not.
function normalizeAllowlistEntry(value) {
  const domain = normalizeDomain(value);
  return domain !== null && getDomain(domain, { allowPrivateDomains: true }) === domain ? domain : null;
}

function domainMatches(cookieDomain, allowlist) {
  const host = normalizeDomain(cookieDomain);
  if (!host) return false;
  return allowlist.some((entry) => {
    const allowed = normalizeAllowlistEntry(entry);
    return allowed !== null && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function matchingAllowedDomain(cookieDomain, allowlist) {
  const host = normalizeDomain(cookieDomain);
  if (!host) return null;
  for (const entry of allowlist) {
    const allowed = normalizeAllowlistEntry(entry);
    if (allowed !== null && (host === allowed || host.endsWith(`.${allowed}`))) return allowed;
  }
  return null;
}

// Bookkeeping only (which group a stored cookie belongs to); never an
// authorization decision, so it does not require registrable entries.
function matchingGroupDomain(cookieDomain, groups) {
  const host = normalizeDomain(cookieDomain);
  if (!host) return null;
  for (const entry of groups) {
    const group = normalizeDomain(entry);
    if (group !== null && (host === group || host.endsWith(`.${group}`))) return group;
  }
  return null;
}

// Revocation is bookkeeping over an already-stored group, not admission to a
// new session. Legacy vaults may contain subdomain groups that are no longer
// accepted as allowlist entries, so keep this matcher independent of the
// registrable-domain authorization rule above.
function groupMatches(cookieDomain, groups) {
  return matchingGroupDomain(cookieDomain, groups) !== null;
}

module.exports = { normalizeDomain, normalizeAllowlistEntry, domainMatches, matchingAllowedDomain, matchingGroupDomain, groupMatches };
