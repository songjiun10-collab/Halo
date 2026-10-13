#!/usr/bin/env node
"use strict";

// Writes build-info.json for a beta build: node tools/set-build-expiry.js <file> <YYYY-MM-DD | +N>
// "+30" means 30 days from now. Refuses a date that does not exist or is already past.

const fs = require("node:fs");
const { parseExpiry, DAY_MS } = require("../main/harness/build-expiry");

const [file, spec] = process.argv.slice(2);
if (!file || !spec) { console.error("usage: set-build-expiry.js <file> <YYYY-MM-DD | +days>"); process.exit(2); }

let date = spec;
if (/^\+\d+$/.test(spec)) date = new Date(Date.now() + Number(spec.slice(1)) * DAY_MS).toISOString().slice(0, 10);
const at = parseExpiry(date);
if (at === null) { console.error(`not a valid date: ${spec}`); process.exit(2); }
if (at < Date.now()) { console.error(`${date} is already past`); process.exit(2); }

fs.writeFileSync(file, `${JSON.stringify({ expiresAt: date }, null, 2)}\n`);
console.log(`build expires at the end of ${date} (UTC): ${file}`);
