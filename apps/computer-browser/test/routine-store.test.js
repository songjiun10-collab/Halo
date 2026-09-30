"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { RoutineStore } = require("../main/harness/routine-store");
const {
  RoutineContractError,
  validateRoutineDefinition,
  computeContentDigest,
  MAX_STEPS,
  MAX_URL_CHARS,
  MAX_NAME_CHARS,
  MAX_SERIALIZED_BYTES,
} = require("../shared/routine-contracts");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-routinestore-"));
}

function validDraft(overrides = {}) {
  return {
    name: "Check inbox",
    description: "Opens the inbox and follows the first unread link.",
    origins: ["https://example.com"],
    steps: [
      { kind: "navigate", url: "https://example.com/inbox" },
      { kind: "follow_link", name: "First unread" },
      { kind: "scroll", direction: "down" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateRoutineDefinition() -- pure schema: bounds, unknown keys, origins
// ---------------------------------------------------------------------------

function fullDefinition(overrides = {}) {
  const content = {
    name: "Check inbox",
    description: "",
    origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/inbox" }],
  };
  const base = {
    schemaVersion: 1,
    routineId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...content,
    ...overrides,
  };
  if (!("digest" in overrides)) {
    base.digest = computeContentDigest({
      name: base.name,
      description: base.description,
      origins: base.origins,
      steps: base.steps,
    });
  }
  return base;
}

test("validateRoutineDefinition() accepts a well-formed definition and returns a normalized copy", () => {
  const definition = fullDefinition();
  const normalized = validateRoutineDefinition(definition);
  assert.deepEqual(normalized, definition);
});

test("validateRoutineDefinition() rejects an unknown top-level field", () => {
  const definition = fullDefinition();
  definition.script = "alert(1)";
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "unknown_field");
});

test("validateRoutineDefinition() rejects an unknown step field", () => {
  const definition = fullDefinition({ steps: [{ kind: "navigate", url: "https://example.com/inbox", code: "rm -rf /" }] });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "unknown_field");
});

test("validateRoutineDefinition() rejects an unknown step kind", () => {
  const definition = fullDefinition({ steps: [{ kind: "run_shell", command: "ls" }] });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "unknown_step_kind");
});

test("validateRoutineDefinition() rejects more than 64 steps", () => {
  const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ kind: "scroll", direction: "down" }));
  const definition = fullDefinition({ steps });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "field_too_large");
});

test("validateRoutineDefinition() rejects an empty steps list", () => {
  const definition = fullDefinition({ steps: [] });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "invalid_field");
});

test("validateRoutineDefinition() rejects a URL longer than 2048 characters", () => {
  const longUrl = `https://example.com/${"a".repeat(MAX_URL_CHARS)}`;
  const definition = fullDefinition({ steps: [{ kind: "navigate", url: longUrl }] });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "field_too_large");
});

test("validateRoutineDefinition() rejects an accessible name longer than 256 characters", () => {
  const definition = fullDefinition({ steps: [{ kind: "follow_link", name: "a".repeat(MAX_NAME_CHARS + 1) }] });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "field_too_large");
});

test("validateRoutineDefinition() rejects a definition whose serialized size exceeds 64 KiB even though every individual field is within its own bound", () => {
  // 64 steps (<=MAX_STEPS) each with a ~2000-char URL (<=MAX_URL_CHARS) stay
  // within every per-field bound individually, but together serialize past
  // MAX_SERIALIZED_BYTES -- this is the whole-definition cap, not a proxy
  // for any single field's cap.
  const longPath = "a".repeat(2000);
  const steps = Array.from({ length: MAX_STEPS }, () => ({ kind: "navigate", url: `https://example.com/${longPath}` }));
  const definition = fullDefinition({ steps });
  assert.throws(
    () => validateRoutineDefinition(definition),
    (err) => err instanceof RoutineContractError && err.code === "definition_too_large",
  );
});

test("validateRoutineDefinition() requires exact normalized HTTP(S) origins", () => {
  const trailingSlash = fullDefinition({ origins: ["https://example.com/"] });
  assert.throws(() => validateRoutineDefinition(trailingSlash), (err) => err instanceof RoutineContractError && err.code === "invalid_origin");

  const nonHttp = fullDefinition({ origins: ["ftp://example.com"] });
  assert.throws(() => validateRoutineDefinition(nonHttp), (err) => err instanceof RoutineContractError);

  const duplicate = fullDefinition({ origins: ["https://example.com", "https://example.com"] });
  assert.throws(() => validateRoutineDefinition(duplicate), (err) => err instanceof RoutineContractError && err.code === "duplicate_origin");
});

test("validateRoutineDefinition() rejects a navigate step whose URL origin is outside the allowlist", () => {
  const definition = fullDefinition({
    origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://evil.example/steal" }],
  });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "origin_not_allowed");
});

test("validateRoutineDefinition() rejects a follow_link expectedHref whose origin is outside the allowlist", () => {
  const definition = fullDefinition({
    origins: ["https://example.com"],
    steps: [{ kind: "follow_link", name: "Docs", expectedHref: "https://evil.example/docs" }],
  });
  assert.throws(() => validateRoutineDefinition(definition), (err) => err instanceof RoutineContractError && err.code === "origin_not_allowed");
});

test("validateRoutineDefinition() only accepts navigate/follow_link/scroll step kinds", () => {
  const okKinds = fullDefinition({
    steps: [
      { kind: "navigate", url: "https://example.com/a" },
      { kind: "follow_link", name: "Next" },
      { kind: "scroll", direction: "up", amount: 200 },
    ],
  });
  assert.doesNotThrow(() => validateRoutineDefinition(okKinds));
});

// ---------------------------------------------------------------------------
// RoutineStore -- persistence, immutability, tombstones, safety
// ---------------------------------------------------------------------------

test("save() with no routineId creates a fresh routine at revision 1", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());
  assert.equal(saved.revision, 1);
  assert.match(saved.routineId, /^[0-9a-f-]{36}$/);
  assert.equal(saved.name, "Check inbox");
  assert.equal(saved.origins.length, 1);
});

test("save() on an existing routineId creates immutable revision 2 while revision 1 stays byte-identical on disk", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const v1 = await store.save(validDraft());

  const v1Path = path.join(storageRoot, "routines", v1.routineId, "revision-0001.json");
  const v1OnDiskBefore = await fs.readFile(v1Path, "utf8");

  const v2 = await store.save(validDraft({ routineId: v1.routineId, name: "Check inbox v2" }));
  assert.equal(v2.routineId, v1.routineId);
  assert.equal(v2.revision, 2);
  assert.equal(v2.name, "Check inbox v2");

  const v1OnDiskAfter = await fs.readFile(v1Path, "utf8");
  assert.equal(v1OnDiskAfter, v1OnDiskBefore);

  const fetchedV1 = await store.get(v1.routineId, 1);
  assert.equal(fetchedV1.name, "Check inbox");
  const fetchedCurrent = await store.get(v1.routineId);
  assert.equal(fetchedCurrent.revision, 2);
});

test("save() propagates the original createdAt across revisions but bumps updatedAt", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const v1 = await store.save(validDraft());
  const v2 = await store.save(validDraft({ routineId: v1.routineId }));
  assert.equal(v2.createdAt, v1.createdAt);
  assert.ok(new Date(v2.updatedAt).getTime() >= new Date(v1.updatedAt).getTime());
});

test("save() rejects an unknown routineId (cannot resurrect or spoof an id that was never created)", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  await assert.rejects(
    store.save(validDraft({ routineId: "22222222-2222-4222-8222-222222222222" })),
    (err) => err.code === "not_found",
  );
});

test("save() rejects unknown top-level fields in its input", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  await assert.rejects(
    store.save(validDraft({ script: "alert(1)" })),
    (err) => err.code === "unknown_field",
  );
});

test("list() returns only current, non-deleted routines sorted deterministically", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const a = await store.save(validDraft({ name: "A" }));
  const b = await store.save(validDraft({ name: "B" }));
  await store.save(validDraft({ routineId: a.routineId, name: "A revised" }));

  const listed = await store.list();
  assert.equal(listed.length, 2);
  const byId = new Map(listed.map((d) => [d.routineId, d]));
  assert.equal(byId.get(a.routineId).name, "A revised");
  assert.equal(byId.get(a.routineId).revision, 2);
  assert.equal(byId.get(b.routineId).name, "B");
});

test("delete() tombstones a routine: list() excludes it, get() without a revision fails, but a pinned revision is still readable", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());

  await store.delete(saved.routineId);

  const listed = await store.list();
  assert.equal(listed.some((d) => d.routineId === saved.routineId), false);

  await assert.rejects(store.get(saved.routineId), (err) => err.code === "routine_deleted");

  const pinned = await store.get(saved.routineId, 1);
  assert.equal(pinned.routineId, saved.routineId);
  assert.equal(pinned.revision, 1);
  assert.equal(pinned.name, "Check inbox");
});

test("delete() is idempotent and rejects an unknown routineId", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());
  await store.delete(saved.routineId);
  await assert.doesNotReject(store.delete(saved.routineId));

  await assert.rejects(
    store.delete("33333333-3333-4333-8333-333333333333"),
    (err) => err.code === "not_found",
  );
});

test("save() after delete() on the same routineId is rejected rather than silently resurrecting it", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());
  await store.delete(saved.routineId);
  await assert.rejects(
    store.save(validDraft({ routineId: saved.routineId })),
    (err) => err.code === "routine_deleted",
  );
});

test("get() refuses a routine directory that is a symlink", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());

  const realDir = path.join(storageRoot, "routines", saved.routineId);
  const decoyDir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-routine-decoy-"));
  const asideDir = `${realDir}.aside`;
  await fs.rename(realDir, asideDir);
  await fs.symlink(decoyDir, realDir);

  await assert.rejects(store.get(saved.routineId), (err) => err.code === "unsafe_path");
  await assert.rejects(store.get(saved.routineId, 1), (err) => err.code === "unsafe_path");

  await fs.unlink(realDir);
  await fs.rename(asideDir, realDir);
  await fs.rm(decoyDir, { recursive: true, force: true });
});

test("get() refuses a revision file that is a symlink", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());

  const revisionPath = path.join(storageRoot, "routines", saved.routineId, "revision-0001.json");
  const decoyFile = path.join(storageRoot, "decoy.json");
  await fs.writeFile(decoyFile, JSON.stringify({ hijacked: true }));
  await fs.unlink(revisionPath);
  await fs.symlink(decoyFile, revisionPath);

  await assert.rejects(store.get(saved.routineId, 1), (err) => err.code === "unsafe_path");
});

test("get() rejects a revision file whose content digest does not match its stored digest", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());

  const revisionPath = path.join(storageRoot, "routines", saved.routineId, "revision-0001.json");
  const onDisk = JSON.parse(await fs.readFile(revisionPath, "utf8"));
  onDisk.name = "Tampered name";
  await fs.writeFile(revisionPath, JSON.stringify(onDisk));

  await assert.rejects(store.get(saved.routineId, 1), (err) => err.code === "digest_mismatch");
});

test("get() rejects a revision file with an unsupported schema shape (malformed/unknown-field corruption)", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());

  const revisionPath = path.join(storageRoot, "routines", saved.routineId, "revision-0001.json");
  const onDisk = JSON.parse(await fs.readFile(revisionPath, "utf8"));
  onDisk.injectedField = "unexpected";
  await fs.writeFile(revisionPath, JSON.stringify(onDisk));

  await assert.rejects(store.get(saved.routineId, 1), (err) => err.code === "unknown_field");
});

test("get() rejects a revision file that is not valid JSON", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const saved = await store.save(validDraft());

  const revisionPath = path.join(storageRoot, "routines", saved.routineId, "revision-0001.json");
  await fs.writeFile(revisionPath, "{not json");

  await assert.rejects(store.get(saved.routineId, 1), (err) => err.code === "storage_corrupt");
});

test("save() rejects a draft that violates the schema (oversized steps) before creating any storage", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ kind: "scroll", direction: "down" }));
  await assert.rejects(store.save(validDraft({ steps })), (err) => err.code === "field_too_large");

  const routinesRoot = path.join(storageRoot, "routines");
  const entries = await fs.readdir(routinesRoot).catch(() => []);
  assert.equal(entries.length, 0);
});

test("get() rejects an invalid routineId and an unknown routineId", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  await assert.rejects(store.get("not-a-uuid"), (err) => err.code === "invalid_routine_id");
  await assert.rejects(
    store.get("44444444-4444-4444-8444-444444444444"),
    (err) => err.code === "not_found",
  );
});

test("list() tolerates an empty/nonexistent storage root", async () => {
  const storageRoot = await mkTempRoot();
  const store = new RoutineStore({ storageRoot });
  assert.deepEqual(await store.list(), []);
});
