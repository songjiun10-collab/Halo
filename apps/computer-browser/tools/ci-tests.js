#!/usr/bin/env node
"use strict";

// Runs every browser test file except the ones named in test/ci-excluded.json (file -> why it cannot run in CI).
// An entry that names a missing file, or has no reason, fails the run, so the list cannot rot.
//   node tools/ci-tests.js           run them
//   node tools/ci-tests.js --list    print the files that would run

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_DIR = path.join(__dirname, "..", "test");
const EXCLUDED_FILE = path.join(TEST_DIR, "ci-excluded.json");

function testFiles(dir = TEST_DIR, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...testFiles(path.join(dir, entry.name), rel));
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

function selectFiles(all, excluded) {
  const problems = [];
  for (const [file, reason] of Object.entries(excluded)) {
    if (!all.includes(file)) problems.push(`ci-excluded.json names ${file}, which does not exist`);
    if (typeof reason !== "string" || reason.trim().length < 10) problems.push(`ci-excluded.json: ${file} needs a reason`);
  }
  return { files: all.filter((file) => !Object.hasOwn(excluded, file)), problems };
}

function main(argv) {
  const excluded = JSON.parse(fs.readFileSync(EXCLUDED_FILE, "utf8"));
  const { files, problems } = selectFiles(testFiles(), excluded);
  if (problems.length) { for (const p of problems) console.error(p); return 1; }
  if (argv.includes("--list")) { console.log(files.join("\n")); return 0; }
  const result = spawnSync(process.execPath, ["--test", ...files.map((f) => path.join("test", f))], { stdio: "inherit", cwd: path.join(__dirname, "..") });
  return result.status ?? 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { testFiles, selectFiles };
