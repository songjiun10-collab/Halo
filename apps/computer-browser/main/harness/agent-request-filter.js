"use strict";

// Ad and tracker frames are the biggest memory cost of a task page: Chromium
// gives each cross-origin ad iframe its own renderer process, and one news or
// weather page can spawn about 30 of them (2.5GB measured). The agent never
// needs them, so requests to these hosts are cancelled on task sessions.
// Only hosts that serve ads or tracking are listed; anything else loads.
const BLOCKED_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googletagservices.com", "adservice.google.com",
  "2mdn.net", "adnxs.com", "taboola.com", "outbrain.com", "criteo.com", "criteo.net",
  "scorecardresearch.com", "amazon-adsystem.com", "adsrvr.org", "rubiconproject.com",
  "pubmatic.com", "openx.net", "moatads.com", "teads.tv", "quantserve.com", "hotjar.com",
  "casalemedia.com", "smartadserver.com", "advertising.com", "yieldmo.com", "sharethrough.com",
];

function isBlockedUrl(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

// A page that is itself on a listed host (the user asked for it) still loads.
function installAgentRequestFilter(session) {
  const hook = session?.webRequest?.onBeforeRequest;
  if (typeof hook !== "function") return false;
  session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    callback({ cancel: details.resourceType !== "mainFrame" && isBlockedUrl(details.url) });
  });
  return true;
}

module.exports = { isBlockedUrl, installAgentRequestFilter, BLOCKED_HOSTS };
