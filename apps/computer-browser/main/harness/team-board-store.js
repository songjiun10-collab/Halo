"use strict";

// A child plan's team board: <storageRoot>/boards/<parentTaskId>.jsonl, one
// entry per line, appended only by the host (ChildAgentCoordinator) from a
// child's already-validated report to its parent. Directory 0700, file 0600,
// symlinks refused, an unparseable line fails the read closed
// (board_corrupt). A board stops growing at MAX_BOARD_BYTES (board_full);
// the board is advisory, so a refused post never affects the message itself.

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOARD_KINDS = Object.freeze(["progress", "evidence", "handoff"]);
const MAX_BOARD_TEXT_CHARS = 1000;
const MAX_BOARD_BYTES = 1024 * 1024;
const MAX_BOARD_READ = 200;
const CHAINS = new Map(); // board path -> append chain, shared by every store in the process

class TeamBoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TeamBoardError";
    this.code = code;
  }
}

function checkEntry(entry, code) {
  const fail = (why) => { throw new TeamBoardError(code, `board entry ${why}`); };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("must be an object");
  if (typeof entry.entryId !== "string" || !entry.entryId || entry.entryId.length > 128) fail("needs an entryId");
  if (!Number.isInteger(entry.parentGoalVersion) || entry.parentGoalVersion < 1) fail("needs a parentGoalVersion");
  if (typeof entry.childTaskId !== "string" || !UUID_RE.test(entry.childTaskId)) fail("needs a child task id");
  if (!BOARD_KINDS.includes(entry.kind)) fail(`kind must be one of ${BOARD_KINDS.join("|")}`);
  if (typeof entry.text !== "string" || !entry.text || entry.text.length > MAX_BOARD_TEXT_CHARS) fail(`text must be 1..${MAX_BOARD_TEXT_CHARS} characters`);
  if (typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))) fail("needs a timestamp");
}

class TeamBoardStore {
  constructor({ storageRoot } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new TeamBoardError("invalid_config", "storageRoot is required");
    this._directory = path.join(storageRoot, "boards");
  }

  _path(parentTaskId) {
    if (typeof parentTaskId !== "string" || !UUID_RE.test(parentTaskId)) throw new TeamBoardError("invalid_board", "board id must be a task UUID");
    return path.join(this._directory, `${parentTaskId}.jsonl`);
  }

  // Resolves the stored entry, or null when that entryId is already there.
  post(parentTaskId, input) {
    let file;
    const entry = input && typeof input === "object" ? {
      entryId: input.entryId, parentGoalVersion: input.parentGoalVersion, childTaskId: input.childTaskId,
      kind: input.kind, text: input.text, at: input.at,
    } : input;
    try {
      file = this._path(parentTaskId);
      checkEntry(entry, "invalid_entry");
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = (CHAINS.get(file) ?? Promise.resolve()).then(async () => {
      await this._ensureDirectory();
      if ((await this._lines(file)).some((line) => this._parse(line).entryId === entry.entryId)) return null;
      const handle = await this._open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
      try {
        const line = `${JSON.stringify(entry)}\n`;
        const { size } = await handle.stat();
        if (size + Buffer.byteLength(line) > MAX_BOARD_BYTES) throw new TeamBoardError("board_full", "the team board is full");
        await handle.chmod(0o600);
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { ...entry };
    });
    const tail = operation.catch(() => {});
    CHAINS.set(file, tail);
    tail.then(() => { if (CHAINS.get(file) === tail) CHAINS.delete(file); });
    return operation;
  }

  // The newest MAX_BOARD_READ entries, oldest first.
  async read(parentTaskId) {
    const file = this._path(parentTaskId);
    await (CHAINS.get(file) ?? Promise.resolve());
    await this._ensureDirectory();
    return (await this._lines(file)).slice(-MAX_BOARD_READ).map((line) => this._parse(line));
  }

  _parse(line) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new TeamBoardError("board_corrupt", "team board has an unparseable line"); }
    checkEntry(entry, "board_corrupt");
    return entry;
  }

  async _lines(file) {
    let handle;
    try {
      handle = await this._open(file, fsConstants.O_RDONLY);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      return (await handle.readFile("utf8")).split("\n").filter((line) => line.length > 0);
    } finally {
      await handle.close();
    }
  }

  async _open(file, flags, mode) {
    try {
      return await fs.open(file, flags | fsConstants.O_NOFOLLOW, mode);
    } catch (error) {
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new TeamBoardError("unsafe_path", "team board must not be a symlink");
      throw error;
    }
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TeamBoardError("unsafe_path", "board directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }
}

module.exports = { TeamBoardStore, TeamBoardError, BOARD_KINDS, MAX_BOARD_BYTES, MAX_BOARD_TEXT_CHARS };
