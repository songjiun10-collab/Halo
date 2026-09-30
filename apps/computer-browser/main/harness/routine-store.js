"use strict";

// Durable, host-owned local storage for saved HALO routine definitions.
// See docs/superpowers/specs/2026-09-28-routine-execution-design.md
// ("Persistence and API surface") and
// docs/superpowers/plans/2026-09-29-routine-execution.md (Task 1).
//
// Layout under `<storageRoot>/routines/<routineId>/` (0700 dir, 0600 files):
//   revision-NNNN.json   one immutable file per revision, never overwritten
//   current.json         {schemaVersion,routineId,currentRevision,createdAt,
//                          deletedAt}, written via tmp+fsync+rename -- the
//                         only mutable file in a routine's directory
//
// Mirrors the no-follow/private-permission/atomic-write conventions already
// used by task-store.js's goal-vNNNN.json/checkpoint.json pair and by
// local-credential-vault.js/local-memory-store.js's tmp+rename writes.

const fsp = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");

const contracts = require("../../shared/routine-contracts");

class RoutineStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoutineStoreError";
    this.code = code;
  }
}

function wrapContractError(err) {
  if (err instanceof contracts.RoutineContractError) {
    return new RoutineStoreError(err.code, err.message);
  }
  return err;
}

function revisionFileName(revision) {
  return `revision-${String(revision).padStart(4, "0")}.json`;
}

async function pathIsSymlink(targetPath) {
  try {
    const stat = await fsp.lstat(targetPath);
    return stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Same shape of defense as task-store.js's resolveTaskDir(): storageRoot
// must already exist (callers always run _ensureRoutinesRoot() first), the
// routines/ root and the per-routine directory must not be symlinks, and a
// routineId can never resolve outside routines/ (the UUID regex already
// forbids "/" and "..", so the dirname check below is defense in depth).
async function resolveRoutineDir(storageRoot, routineId) {
  if (typeof routineId !== "string" || !contracts.UUID_RE.test(routineId)) {
    throw new RoutineStoreError("invalid_routine_id", `routineId must be a UUID: ${JSON.stringify(routineId)}`);
  }
  const root = await fsp.realpath(storageRoot);
  const routinesRoot = path.join(root, "routines");
  if (await pathIsSymlink(routinesRoot)) {
    throw new RoutineStoreError("unsafe_path", "routines root must not be a symlink");
  }
  const routineDir = path.join(routinesRoot, routineId);
  if (path.dirname(routineDir) !== routinesRoot) {
    throw new RoutineStoreError("invalid_routine_id", "routineId resolves outside the routines root");
  }
  if (await pathIsSymlink(routineDir)) {
    throw new RoutineStoreError("unsafe_path", "routine directory must not be a symlink");
  }
  return { routinesRoot, routineDir };
}

async function fsyncDir(dirPath) {
  const fh = await fsp.open(dirPath, fsConstants.O_RDONLY);
  try {
    await fh.sync();
  } catch (error) {
    // Some platforms reject fsync on a directory descriptor; the rename/
    // create itself is still durable there (matches task-store.js).
    if (error.code !== "EINVAL" && error.code !== "EISDIR") throw error;
  } finally {
    await fh.close();
  }
}

async function writeFileExclusive(filePath, contentsJson) {
  const fh = await fsp.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fh.writeFile(contentsJson, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readFileNoFollow(filePath) {
  const fh = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

async function writeIndexAtomic(routineDir, index) {
  const finalPath = path.join(routineDir, "current.json");
  const tmpPath = path.join(routineDir, `.current-${crypto.randomUUID()}.tmp`);
  await writeFileExclusive(tmpPath, JSON.stringify(index));
  try {
    await fsp.rename(tmpPath, finalPath);
    await fsyncDir(routineDir);
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

// current.json is store-private bookkeeping, not a RoutineDefinition, so it
// gets its own (lighter) shape check rather than shared/routine-contracts.js.
const INDEX_FIELDS = ["schemaVersion", "routineId", "currentRevision", "createdAt", "deletedAt"];

function isValidIndexShape(value, routineId) {
  if (!contracts.isPlainObject(value)) return false;
  if (Object.keys(value).some((key) => !INDEX_FIELDS.includes(key))) return false;
  if (value.schemaVersion !== contracts.SCHEMA_VERSION) return false;
  if (value.routineId !== routineId) return false;
  if (!Number.isInteger(value.currentRevision) || value.currentRevision < 1) return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (value.deletedAt !== null && (typeof value.deletedAt !== "string" || Number.isNaN(Date.parse(value.deletedAt)))) return false;
  return true;
}

async function readIndex(routineDir, routineId) {
  let raw;
  try {
    raw = await readFileNoFollow(path.join(routineDir, "current.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      throw new RoutineStoreError("unsafe_path", "routine index must not be a symlink");
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RoutineStoreError("storage_corrupt", "routine index is not valid JSON");
  }
  if (!isValidIndexShape(parsed, routineId)) {
    throw new RoutineStoreError("storage_corrupt", "routine index has an unsupported shape");
  }
  return parsed;
}

// The one function used for BOTH assembling a new revision record and
// re-reading one back off disk (mirroring validateRoutineDefinition's own
// write/read symmetry): shape/bounds via the contracts module, then a
// routineId/revision cross-check against the path this was read from, then
// digest re-verification against the definition's own content.
async function readRevisionFile(routineDir, routineId, revision) {
  let raw;
  try {
    raw = await readFileNoFollow(path.join(routineDir, revisionFileName(revision)));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new RoutineStoreError("not_found", `revision ${revision} of routine ${routineId} was not found`);
    }
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      throw new RoutineStoreError("unsafe_path", "revision file must not be a symlink");
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RoutineStoreError("storage_corrupt", "revision file is not valid JSON");
  }
  let normalized;
  try {
    normalized = contracts.validateRoutineDefinition(parsed);
  } catch (error) {
    throw wrapContractError(error);
  }
  if (normalized.routineId !== routineId || normalized.revision !== revision) {
    throw new RoutineStoreError("storage_corrupt", "revision file does not match its own routineId/revision");
  }
  const expectedDigest = contracts.computeContentDigest(normalized);
  if (expectedDigest !== normalized.digest) {
    throw new RoutineStoreError("digest_mismatch", "revision content digest does not match its stored digest");
  }
  return normalized;
}

// save()'s own input surface: content the caller controls, plus an optional
// routineId naming an existing routine to add a revision to. routineId is
// intentionally never caller-chosen for a brand-new routine (no upsert-by-id)
// -- this keeps "does this id already exist" unambiguous and means a
// tombstoned id can never be silently resurrected by saving over it.
const SAVE_INPUT_FIELDS = ["routineId", "name", "description", "origins", "steps"];

class RoutineStore {
  constructor({ storageRoot, now } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) {
      throw new RoutineStoreError("invalid_config", "storageRoot is required");
    }
    this._storageRoot = path.resolve(storageRoot);
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._writeChain = Promise.resolve();
  }

  async _ensureRoutinesRoot() {
    await fsp.mkdir(this._storageRoot, { recursive: true, mode: 0o700 });
    const routinesRoot = path.join(this._storageRoot, "routines");
    await fsp.mkdir(routinesRoot, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(routinesRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RoutineStoreError("unsafe_path", "routines root must not be a symlink");
    }
  }

  // Mutating operations (save/delete) share one FIFO chain across the whole
  // store instance, the same coarse-grained serialization local-credential-
  // vault.js/local-memory-store.js already use for their single file -- good
  // enough here too, since routine saves are rare, user-initiated actions.
  _serialize(fn) {
    const operation = this._writeChain.then(fn);
    this._writeChain = operation.catch(() => {});
    return operation;
  }

  async list() {
    await this._ensureRoutinesRoot();
    const routinesRoot = path.join(this._storageRoot, "routines");
    let entries;
    try {
      entries = await fsp.readdir(routinesRoot);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    const results = [];
    for (const name of entries) {
      if (!contracts.UUID_RE.test(name)) continue; // ignore stray non-UUID entries
      let routineDir;
      try {
        ({ routineDir } = await resolveRoutineDir(this._storageRoot, name));
      } catch {
        continue; // a symlinked/unsafe entry must not break the whole listing
      }
      let index;
      try {
        index = await readIndex(routineDir, name);
      } catch {
        continue; // a corrupt index must not break the whole listing
      }
      if (!index || index.deletedAt !== null) continue;
      let definition;
      try {
        definition = await readRevisionFile(routineDir, name, index.currentRevision);
      } catch {
        continue; // a corrupt/tampered revision must not break the whole listing
      }
      results.push(definition);
    }

    results.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.routineId.localeCompare(b.routineId));
    return results;
  }

  async get(routineId, revision) {
    await this._ensureRoutinesRoot();
    const { routineDir } = await resolveRoutineDir(this._storageRoot, routineId);

    if (revision !== undefined && revision !== null) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new RoutineStoreError("invalid_revision", "revision must be a positive integer");
      }
      // An explicit revision bypasses the tombstone check entirely: a
      // deleted routine still retains its immutable revision files for
      // active/recoverable tasks (design spec, "Failure and recovery
      // semantics").
      return readRevisionFile(routineDir, routineId, revision);
    }

    const index = await readIndex(routineDir, routineId);
    if (!index) throw new RoutineStoreError("not_found", `routine ${routineId} was not found`);
    if (index.deletedAt !== null) {
      throw new RoutineStoreError("routine_deleted", `routine ${routineId} has been deleted`);
    }
    return readRevisionFile(routineDir, routineId, index.currentRevision);
  }

  save(input) {
    return this._serialize(() => this._save(input));
  }

  async _save(input) {
    if (!contracts.isPlainObject(input)) {
      throw new RoutineStoreError("invalid_shape", "save() input must be a plain object");
    }
    for (const key of Object.keys(input)) {
      if (!SAVE_INPUT_FIELDS.includes(key)) {
        throw new RoutineStoreError("unknown_field", `save() input has unknown field "${key}"`);
      }
    }

    await this._ensureRoutinesRoot();

    const now = this._now();
    let routineId = input.routineId;
    let isNewRoutine;

    if (routineId === undefined || routineId === null) {
      routineId = crypto.randomUUID();
      isNewRoutine = true;
    } else {
      if (typeof routineId !== "string" || !contracts.UUID_RE.test(routineId)) {
        throw new RoutineStoreError("invalid_routine_id", "routineId must be a UUID");
      }
      isNewRoutine = false;
    }

    const { routineDir } = await resolveRoutineDir(this._storageRoot, routineId);

    let revision;
    let createdAt;
    if (isNewRoutine) {
      revision = 1;
      createdAt = now;
    } else {
      const existingIndex = await readIndex(routineDir, routineId);
      if (!existingIndex) throw new RoutineStoreError("not_found", `routine ${routineId} was not found`);
      if (existingIndex.deletedAt !== null) {
        throw new RoutineStoreError("routine_deleted", `routine ${routineId} has been deleted`);
      }
      revision = existingIndex.currentRevision + 1;
      createdAt = existingIndex.createdAt;
    }

    const description = input.description === undefined ? "" : input.description;
    const digest = contracts.computeContentDigest({
      name: input.name,
      description,
      origins: input.origins,
      steps: input.steps,
    });

    const candidate = {
      schemaVersion: contracts.SCHEMA_VERSION,
      routineId,
      revision,
      name: input.name,
      description,
      origins: input.origins,
      steps: input.steps,
      createdAt,
      updatedAt: now,
      digest,
    };

    // Validate BEFORE touching the filesystem: an invalid draft must never
    // leave behind an empty routine directory or a stray revision file.
    let normalized;
    try {
      normalized = contracts.validateRoutineDefinition(candidate);
    } catch (error) {
      throw wrapContractError(error);
    }

    if (isNewRoutine) {
      await fsp.mkdir(routineDir, { recursive: false, mode: 0o700 });
    }

    await writeFileExclusive(path.join(routineDir, revisionFileName(revision)), JSON.stringify(normalized));
    await fsyncDir(routineDir);

    await writeIndexAtomic(routineDir, {
      schemaVersion: contracts.SCHEMA_VERSION,
      routineId,
      currentRevision: revision,
      createdAt,
      deletedAt: null,
    });

    return normalized;
  }

  delete(routineId) {
    return this._serialize(() => this._delete(routineId));
  }

  async _delete(routineId) {
    if (typeof routineId !== "string" || !contracts.UUID_RE.test(routineId)) {
      throw new RoutineStoreError("invalid_routine_id", "routineId must be a UUID");
    }
    await this._ensureRoutinesRoot();
    const { routineDir } = await resolveRoutineDir(this._storageRoot, routineId);
    const index = await readIndex(routineDir, routineId);
    if (!index) throw new RoutineStoreError("not_found", `routine ${routineId} was not found`);
    if (index.deletedAt !== null) return; // already tombstoned: idempotent
    await writeIndexAtomic(routineDir, { ...index, deletedAt: this._now() });
  }
}

module.exports = { RoutineStore, RoutineStoreError };
