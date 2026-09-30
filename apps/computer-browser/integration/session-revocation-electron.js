"use strict";

// Real-Electron check for imported-session revocation. Run as:
// `electron integration/session-revocation-electron.js`.

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { app, session: electronSession } = require("electron");
const { clearSessionCookies, clearDisallowedSessionCookies } = require("../main/harness/profile-import/session-injector");

async function main() {
  await app.whenReady();
  const session = electronSession.fromPartition(`halo-session-revocation-${randomUUID()}`);
  await session.cookies.set({ url: "https://claude.ai/", domain: ".claude.ai", name: "halo-test-session", value: "not-a-real-secret", path: "/", secure: true });
  await session.cookies.set({ url: "https://accounts.claude.ai/auth", domain: "accounts.claude.ai", name: "halo-test-account", value: "not-a-real-secret", path: "/auth", secure: true });
  await session.cookies.set({ url: "https://chatgpt.com/", domain: ".chatgpt.com", name: "halo-test-other", value: "not-a-real-secret", path: "/", secure: true });

  const revoked = await clearSessionCookies(session, ["claude.ai"]);
  assert.deepEqual(revoked, { removed: 2, failed: 0 });
  let remaining = await session.cookies.get({});
  assert.deepEqual(remaining.map((cookie) => cookie.domain), [".chatgpt.com"]);

  const narrowed = await clearDisallowedSessionCookies(session, []);
  assert.deepEqual(narrowed, { removed: 1, failed: 0 });
  remaining = await session.cookies.get({});
  assert.deepEqual(remaining, []);
  console.log(JSON.stringify({ pass: true, electron: process.versions.electron, revoked, narrowed }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  app.quit();
});
