"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ProfileImportError } = require("./chrome-cookie-reader");

const MAX_BOOKMARKS = 5000;
const MAX_ENGINES = 100;
const MAX_STARTUP_URLS = 20;
const MAX_URL_BYTES = 2048;
const MAX_TITLE_BYTES = 512;
const RESTORE_SPECIFIC_URLS = 4;

function defaultChromeRoot() {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

const isWebUrl = (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_URL_BYTES && /^https?:\/\//i.test(value);
const clip = (value) => (typeof value === "string" ? value.slice(0, MAX_TITLE_BYTES) : "");

// A missing file is legitimately empty; an unreadable or malformed one is a
// failure the importer must not mistake for "the user has no bookmarks".
async function readJson(file) {
  let text;
  try { text = await fs.readFile(file, "utf8"); }
  catch (error) { return error.code === "ENOENT" ? { state: "missing" } : { state: "failed" }; }
  try { return { state: "ok", value: JSON.parse(text) }; } catch { return { state: "failed" }; }
}

function flattenBookmarks(roots) {
  const out = [];
  const walk = (node, folderPath) => {
    if (out.length >= MAX_BOOKMARKS || !node || typeof node !== "object") return;
    if (node.type === "url") {
      if (isWebUrl(node.url)) out.push({ folder: folderPath, title: clip(node.name), url: node.url });
    } else if (Array.isArray(node.children)) {
      const next = folderPath ? `${folderPath}/${clip(node.name)}` : clip(node.name);
      for (const child of node.children) walk(child, next);
    }
  };
  for (const key of ["bookmark_bar", "other", "synced"]) walk(roots?.[key], "");
  return out;
}

// Returns null when the database exists but could not be read.
async function readSearchEngines(webDataFile) {
  try { await fs.access(webDataFile); } catch { return []; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "halo-chrome-webdata-"));
  try {
    const target = path.join(directory, "Web Data");
    await fs.copyFile(webDataFile, target);
    for (const suffix of ["-wal", "-shm"]) await fs.copyFile(webDataFile + suffix, target + suffix).catch(() => {});
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(target);
    try {
      return db.prepare("SELECT short_name, keyword, url FROM keywords").all()
        .filter((row) => typeof row.url === "string" && /^https:\/\//i.test(row.url) && row.url.includes("{searchTerms}") && Buffer.byteLength(row.url, "utf8") <= MAX_URL_BYTES)
        .slice(0, MAX_ENGINES)
        .map((row) => ({ name: clip(row.short_name), keyword: clip(row.keyword), url: row.url }));
    } finally { db.close(); }
  } catch { return null; }
  finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

async function readChromeSettings({ chromeRoot = defaultChromeRoot(), profile = "Default" } = {}) {
  if (typeof profile !== "string" || !/^(Default|Profile \d{1,3})$/.test(profile)) throw new ProfileImportError("invalid_config", "profile must be Default or Profile N");
  const dir = path.join(chromeRoot, profile);
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "not_found" };
  } catch { return { status: "not_found" }; }

  const bookmarksFile = await readJson(path.join(dir, "Bookmarks"));
  const preferencesFile = await readJson(path.join(dir, "Preferences"));
  const searchEngines = await readSearchEngines(path.join(dir, "Web Data"));
  const failed = [];
  if (bookmarksFile.state === "failed") failed.push("bookmarks");
  if (preferencesFile.state === "failed") failed.push("preferences");
  if (searchEngines === null) failed.push("searchEngines");
  const bookmarksJson = bookmarksFile.state === "ok" ? bookmarksFile.value : null;
  const preferences = preferencesFile.state === "ok" ? preferencesFile.value : null;
  let homepage = null;
  let startupUrls = [];
  if (preferences && typeof preferences === "object") {
    if (preferences.homepage_is_newtabpage === true) homepage = { url: null, useNewTab: true };
    else if (isWebUrl(preferences.homepage)) homepage = { url: preferences.homepage, useNewTab: false };
    if (preferences.session?.restore_on_startup === RESTORE_SPECIFIC_URLS && Array.isArray(preferences.session.startup_urls)) {
      startupUrls = preferences.session.startup_urls.filter(isWebUrl).slice(0, MAX_STARTUP_URLS);
    }
  }
  return {
    status: "ok",
    bookmarks: flattenBookmarks(bookmarksJson?.roots),
    searchEngines: searchEngines ?? [],
    homepage,
    startupUrls,
    ...(failed.length ? { failed } : {}),
  };
}

module.exports = { readChromeSettings };
