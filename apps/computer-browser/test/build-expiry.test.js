"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { parseExpiry, readBuildInfo, checkBuild, DAY_MS } = require("../main/harness/build-expiry");

test("a date means the end of that day (UTC); impossible or odd values are refused", () => {
  assert.equal(new Date(parseExpiry("2027-02-28")).toISOString(), "2027-02-28T23:59:59.999Z");
  assert.equal(parseExpiry("2028-02-29") !== null, true, "leap day exists");
  for (const bad of ["2027-02-31", "2027-13-01", "2027-2-1", "tomorrow", "", null, undefined, 20270228, {}]) assert.equal(parseExpiry(bad), null, String(bad));
  assert.equal(parseExpiry("2027-02-28T12:00:00Z"), Date.parse("2027-02-28T12:00:00Z"));
});

test("a missing file is a development build; an unreadable or malformed one fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-build-info-"));
  const file = path.join(dir, "build-info.json");
  assert.deepEqual(readBuildInfo(file), { expiresAt: null, invalid: false });
  fs.writeFileSync(file, JSON.stringify({ expiresAt: "2027-02-28" }));
  assert.equal(readBuildInfo(file).expiresAt, parseExpiry("2027-02-28"));
  for (const content of ["{not json", "[]", "null", JSON.stringify({ expiresAt: "soon" }), JSON.stringify({ expiresAt: 12345 })]) {
    fs.writeFileSync(file, content);
    assert.deepEqual(readBuildInfo(file), { expiresAt: null, invalid: true }, content);
  }
  fs.writeFileSync(file, JSON.stringify({ somethingElse: true }));
  assert.deepEqual(readBuildInfo(file), { expiresAt: null, invalid: false }, "no date means no expiry");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkBuild: live, last day, expired, no expiry, unreadable", () => {
  const at = parseExpiry("2027-02-28");
  const info = { expiresAt: at, invalid: false };
  assert.deepEqual(checkBuild(info, at - 10 * DAY_MS), { expired: false, daysLeft: 10, expiresAt: at });
  assert.equal(checkBuild(info, at).expired, false, "valid through the last millisecond");
  assert.equal(checkBuild(info, at + 1).expired, true);
  assert.equal(checkBuild(info, at + 1).daysLeft, 0);
  assert.deepEqual(checkBuild({ expiresAt: null, invalid: false }), { expired: false, daysLeft: null, expiresAt: null });
  assert.deepEqual(checkBuild(null), { expired: false, daysLeft: null, expiresAt: null });
  assert.equal(checkBuild({ expiresAt: null, invalid: true }).expired, true, "unreadable fails closed");
});

test("the packaging tool writes a usable file and refuses past or impossible dates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-expiry-tool-"));
  const file = path.join(dir, "build-info.json");
  const tool = path.join(__dirname, "..", "tools", "set-build-expiry.js");
  execFileSync(process.execPath, [tool, file, "+30"]);
  const info = readBuildInfo(file);
  assert.equal(info.invalid, false);
  assert.equal(checkBuild(info).expired, false);
  assert.ok(checkBuild(info).daysLeft >= 29 && checkBuild(info).daysLeft <= 31);
  for (const bad of ["2020-01-01", "2027-02-31", "soon"]) {
    const result = spawnSync(process.execPath, [tool, path.join(dir, "x.json"), bad]);
    assert.equal(result.status, 2, bad);
    assert.equal(fs.existsSync(path.join(dir, "x.json")), false, "nothing written for " + bad);
  }
  assert.equal(spawnSync(process.execPath, [tool]).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
