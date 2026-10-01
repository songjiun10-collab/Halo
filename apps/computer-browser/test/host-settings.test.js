"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { HostSettingsStore } = require("../main/harness/host-settings");

test("host settings default to browse/medium/budgeted and persist validated values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    assert.deepEqual(await settings.load(), { version: 3, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", memoryPolicy: "budgeted", plannerProvider: "none" });
    await settings.update({ executionMode: "parallel", permissionMode: "interact", plannerEffort: "high" });
    assert.deepEqual(await settings.load(), { version: 3, executionMode: "parallel", permissionMode: "interact", plannerEffort: "high", memoryPolicy: "budgeted", plannerProvider: "none" });
    const stat = await fs.stat(path.join(root, "host-settings.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host settings reject invalid mode or effort without changing persisted values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    await settings.load();
    await assert.rejects(settings.update({ permissionMode: "unrestricted" }), { code: "invalid_permission_mode" });
    await assert.rejects(settings.update({ plannerEffort: "--dangerous" }), { code: "invalid_planner_effort" });
    assert.deepEqual(await settings.load(), { version: 3, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", memoryPolicy: "budgeted", plannerProvider: "none" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host settings reject an invalid memoryPolicy value", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    await settings.load();
    await assert.rejects(settings.update({ memoryPolicy: "unlimited" }, { actor: "user" }), { code: "invalid_memory_policy" });
    assert.equal((await settings.load()).memoryPolicy, "budgeted");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host settings atomically migrate a v1 file to v3, defaulting memoryPolicy to budgeted and plannerProvider to none", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const file = path.join(root, "host-settings.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, executionMode: "parallel", permissionMode: "interact", plannerEffort: "high" }), { mode: 0o600 });
    const settings = new HostSettingsStore({ storageRoot: root });
    const loaded = await settings.load();
    assert.deepEqual(loaded, { version: 3, executionMode: "parallel", permissionMode: "interact", plannerEffort: "high", memoryPolicy: "budgeted", plannerProvider: "none" });
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(onDisk, loaded);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host settings refuse a corrupt/unknown-shaped v1-labeled file rather than guessing a migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const file = path.join(root, "host-settings.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, executionMode: "parallel", extraField: "unexpected" }), { mode: 0o600 });
    const settings = new HostSettingsStore({ storageRoot: root });
    await assert.rejects(settings.load(), { code: "invalid_settings" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("changing memoryPolicy requires a trusted actor and durably records an audit entry before becoming default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    await settings.load();

    await assert.rejects(settings.update({ memoryPolicy: "user_override" }), { code: "actor_required" });
    assert.equal((await settings.load()).memoryPolicy, "budgeted", "a rejected actor-less change must not take effect");
    assert.deepEqual(await settings.listMemoryPolicyAudit(), []);

    const before = new Date();
    const updated = await settings.update({ memoryPolicy: "user_override" }, { actor: "user" });
    assert.equal(updated.memoryPolicy, "user_override");

    const audit = await settings.listMemoryPolicyAudit();
    assert.equal(audit.length, 1);
    assert.match(audit[0].eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(audit[0].actor, "user");
    assert.equal(audit[0].mode, "user_override");
    assert.ok(new Date(audit[0].at).getTime() >= before.getTime());

    // Changing an unrelated field never requires an actor and never audits.
    await settings.update({ plannerEffort: "high" });
    assert.deepEqual(await settings.listMemoryPolicyAudit(), audit);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the current memory-policy selection links to the durable user audit event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    assert.deepEqual(await settings.getMemoryPolicySelection(), { mode: "budgeted", auditEventId: null, actor: null, at: null });
    await settings.update({ memoryPolicy: "user_override" }, { actor: "user" });
    const audit = (await settings.listMemoryPolicyAudit())[0];
    assert.deepEqual(await settings.getMemoryPolicySelection(), {
      mode: "user_override", auditEventId: audit.eventId, actor: "user", at: audit.at,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an override setting with no user audit cannot be selected for a run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    await fs.writeFile(path.join(root, "host-settings.json"), JSON.stringify({
      version: 2, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", memoryPolicy: "user_override",
    }));
    await assert.rejects(settings.getMemoryPolicySelection(), { code: "audit_missing" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host settings refuse a symlinked settings file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  const external = path.join(root, "external.json");
  const target = path.join(root, "host-settings.json");
  try {
    await fs.writeFile(external, JSON.stringify({ version: 1, permissionMode: "full", plannerEffort: "max" }));
    await fs.symlink(external, target);
    const settings = new HostSettingsStore({ storageRoot: root });
    await assert.rejects(settings.load(), { code: "unsafe_path" });
    assert.match(await fs.readFile(external, "utf8"), /"full"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("host settings migrate an exact v2 file to v3 with the planner left off", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const file = path.join(root, "host-settings.json");
    await fs.writeFile(file, JSON.stringify({ version: 2, executionMode: "parallel", permissionMode: "interact", plannerEffort: "high", memoryPolicy: "budgeted" }), { mode: 0o600 });
    const loaded = await new HostSettingsStore({ storageRoot: root }).load();
    assert.deepEqual(loaded, { version: 3, executionMode: "parallel", permissionMode: "interact", plannerEffort: "high", memoryPolicy: "budgeted", plannerProvider: "none" });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), loaded);
    await fs.writeFile(file, JSON.stringify({ version: 2, executionMode: "parallel", permissionMode: "interact", plannerEffort: "high", memoryPolicy: "budgeted", plannerProvider: "claude_code" }));
    await assert.rejects(new HostSettingsStore({ storageRoot: root }).load(), { code: "invalid_settings" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plannerProvider accepts only allowlisted ids and never a command or path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-settings-"));
  try {
    const settings = new HostSettingsStore({ storageRoot: root });
    assert.equal((await settings.update({ plannerProvider: "claude_code" })).plannerProvider, "claude_code");
    for (const plannerProvider of ["codex", "/bin/sh", "toString", "__proto__", null, ["claude_code"]]) {
      await assert.rejects(settings.update({ plannerProvider }), { code: "invalid_planner_provider" }, String(plannerProvider));
    }
    assert.equal((await settings.load()).plannerProvider, "claude_code");
    assert.equal((await settings.update({ plannerProvider: "none" })).plannerProvider, "none");
    await assert.rejects(settings.update({ plannerCommand: "/bin/sh" }), { code: "invalid_settings" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
