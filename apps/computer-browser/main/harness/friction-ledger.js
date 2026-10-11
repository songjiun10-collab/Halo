"use strict";

// Origins that recently showed a human check, kept across restarts. A Map the
// controllers use directly; every change is written to one small private file.
// Corrupt or stale content is dropped on load, never trusted.

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "friction.json";
const MAX_ENTRIES = 200;

class FrictionLedger extends Map {
  constructor({ storageRoot, ttlMs, now = Date.now } = {}) {
    super();
    this._file = typeof storageRoot === "string" && storageRoot ? path.join(storageRoot, FILE_NAME) : null;
    this._ttlMs = ttlMs;
    this._now = now;
    this._loading = true;
    this._load();
    this._loading = false;
  }

  _load() {
    if (!this._file) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this._file, "utf8")); } catch { return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const now = this._now();
    for (const [origin, entry] of Object.entries(parsed).slice(0, MAX_ENTRIES)) {
      let valid = false;
      try { valid = new URL(origin).origin === origin; } catch { valid = false; }
      if (!valid || !entry || !Number.isFinite(entry.at) || !Number.isInteger(entry.count) || entry.count < 1) continue;
      if (entry.at > now || now - entry.at > this._ttlMs) continue;
      super.set(origin, { at: entry.at, count: entry.count });
    }
  }

  _save() {
    if (!this._file || this._loading) return;
    const body = JSON.stringify(Object.fromEntries([...this].slice(-MAX_ENTRIES)));
    const temporary = `${this._file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      fs.renameSync(temporary, this._file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
  }

  set(key, value) {
    const result = super.set(key, value);
    this._save();
    return result;
  }

  delete(key) {
    const had = super.delete(key);
    if (had) this._save();
    return had;
  }
}

module.exports = { FrictionLedger, FRICTION_FILE_NAME: FILE_NAME };
