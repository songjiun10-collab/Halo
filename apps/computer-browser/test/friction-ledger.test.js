"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FrictionLedger } = require("../main/harness/friction-ledger");

const DAY = 24 * 60 * 60 * 1000;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "halo-friction-"));

test("entries survive a restart and the file is private", () => {
  const dir = root();
  const now = () => 1_000_000;
  const a = new FrictionLedger({ storageRoot: dir, ttlMs: DAY, now });
  a.set("https://a.test", { at: 999_000, count: 2 });
  const b = new FrictionLedger({ storageRoot: dir, ttlMs: DAY, now });
  assert.deepEqual(b.get("https://a.test"), { at: 999_000, count: 2 });
  assert.equal(fs.statSync(path.join(dir, "friction.json")).mode & 0o077, 0, "group and others get no access");
});

test("expired, future, malformed and non-origin entries are dropped on load", () => {
  const dir = root();
  const now = () => 10 * DAY;
  fs.writeFileSync(path.join(dir, "friction.json"), JSON.stringify({
    "https://old.test": { at: 1, count: 1 },
    "https://future.test": { at: 11 * DAY, count: 1 },
    "https://bad-count.test": { at: now() - 1000, count: 0 },
    "https://a.test/path": { at: now() - 1000, count: 1 },
    "not a url": { at: now() - 1000, count: 1 },
    "https://ok.test": { at: now() - 1000, count: 3 },
  }));
  const ledger = new FrictionLedger({ storageRoot: dir, ttlMs: DAY, now });
  assert.deepEqual([...ledger.keys()], ["https://ok.test"]);
});

test("a corrupt file starts empty instead of failing", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "friction.json"), "{not json");
  assert.equal(new FrictionLedger({ storageRoot: dir, ttlMs: DAY }).size, 0);
  fs.writeFileSync(path.join(dir, "friction.json"), "[1,2]");
  assert.equal(new FrictionLedger({ storageRoot: dir, ttlMs: DAY }).size, 0);
});

test("without a storage root it behaves as a plain in-memory map", () => {
  const ledger = new FrictionLedger({ ttlMs: DAY });
  ledger.set("https://a.test", { at: 1, count: 1 });
  assert.equal(ledger.size, 1);
  assert.ok(ledger instanceof Map);
});
