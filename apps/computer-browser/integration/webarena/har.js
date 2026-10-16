"use strict";

// Minimal HAR 1.2 recorder for WebArena-Verified's offline, network-event
// evaluation. It records method, URL, status and (bounded) request body for
// each request of one Electron session. Headers are not recorded: the
// evaluators documented for state-changing tasks read URL, method and status.

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ENTRIES = 20000;

function bodyText(uploadData) {
  if (!Array.isArray(uploadData) || uploadData.length === 0) return null;
  const parts = [];
  let size = 0;
  for (const item of uploadData) {
    if (!item || !item.bytes) continue;
    const chunk = Buffer.from(item.bytes);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    parts.push(chunk);
  }
  return parts.length ? Buffer.concat(parts).toString("utf8") : null;
}

function createHarRecorder({ now = () => Date.now() } = {}) {
  const pending = new Map();
  const entries = [];
  let dropped = 0;

  function onBeforeRequest(details) {
    pending.set(details.id, { startedAt: now(), method: details.method, url: details.url, postData: bodyText(details.uploadData) });
  }

  function finish(details, status) {
    const start = pending.get(details.id);
    if (!start) return;
    pending.delete(details.id);
    if (entries.length >= MAX_ENTRIES) { dropped += 1; return; }
    const time = Math.max(0, now() - start.startedAt);
    entries.push({
      startedDateTime: new Date(start.startedAt).toISOString(),
      time,
      request: {
        method: start.method, url: start.url, httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1,
        bodySize: start.postData === null ? 0 : Buffer.byteLength(start.postData),
        ...(start.postData === null ? {} : { postData: { mimeType: "application/x-www-form-urlencoded", text: start.postData } }),
      },
      response: { status, statusText: "", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1 },
      cache: {},
      timings: { send: 0, wait: time, receive: 0 },
    });
  }

  const onCompleted = (details) => finish(details, Number.isInteger(details.statusCode) ? details.statusCode : 0);
  // A request that never completed is recorded with status 0 so it is visible
  // rather than silently missing.
  const onErrorOccurred = (details) => finish(details, 0);

  function attach(session) {
    const filter = { urls: ["<all_urls>"] };
    session.webRequest.onBeforeRequest(filter, (details, callback) => { onBeforeRequest(details); callback({}); });
    session.webRequest.onCompleted(filter, onCompleted);
    session.webRequest.onErrorOccurred(filter, onErrorOccurred);
  }

  const toHar = () => ({ log: { version: "1.2", creator: { name: "halo-webarena-run", version: "0" }, entries: [...entries], ...(dropped ? { comment: `${dropped} entries dropped` } : {}) } });

  return { attach, onBeforeRequest, onCompleted, onErrorOccurred, toHar, get size() { return entries.length; } };
}

module.exports = { createHarRecorder, MAX_ENTRIES, MAX_BODY_BYTES };
