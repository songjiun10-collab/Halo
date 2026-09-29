"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { WorkGoalStore } = require("../main/harness/work-goal-store");

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "halo-work-goal-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function input(objective = "Verify project") {
  return {
    objective,
    successCriteria: [{ id: "reviewed", text: "User reviewed result", required: true, verification: "user" }],
    budget: { maxTasks: 3 },
  };
}

test("create persists a host-assigned Goal and load replays it after close", async (t) => {
  const storageRoot = await tempRoot(t);
  const first = new WorkGoalStore({ storageRoot });
  await first.load();
  const created = await first.create(input());
  assert.match(created.goalId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(created.spec.version, 1);
  assert.equal(created.status, "active");
  await first.close();

  const second = new WorkGoalStore({ storageRoot });
  await second.load();
  assert.equal(second.getActive().goalId, created.goalId);
  assert.equal(second.get(created.goalId).spec.objective, "Verify project");
  await second.close();
});

test("storage uses private directories and journal and pointer files", async (t) => {
  const storageRoot = await tempRoot(t);
  const store = new WorkGoalStore({ storageRoot });
  await store.load();
  const { goalId } = await store.create(input());
  const goalsRoot = path.join(storageRoot, "work-goals");
  const goalDir = path.join(goalsRoot, goalId);
  for (const dir of [goalsRoot, goalDir]) {
    assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
  }
  for (const file of [path.join(goalDir, "events.jsonl"), path.join(goalsRoot, "active.json")]) {
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  }
  await store.close();
});

test("a second active Goal is rejected until the first is archived", async (t) => {
  const storageRoot = await tempRoot(t);
  const store = new WorkGoalStore({ storageRoot });
  await store.load();
  const first = await store.create(input("First"));
  await assert.rejects(() => store.create(input("Second")), (error) => error.code === "active_goal_exists");
  await store.append({ goalId: first.goalId, expectedVersion: 1, type: "work_goal_paused", payload: { actor: "user" } });
  await store.append({ goalId: first.goalId, expectedVersion: 1, type: "work_goal_archived", payload: { actor: "user" } });
  assert.equal(store.getActive(), null);
  const second = await store.create(input("Second"));
  assert.notEqual(second.goalId, first.goalId);
  assert.equal(store.getActive().goalId, second.goalId);
  assert.deepEqual(store.listHistory().map((goal) => goal.goalId), [first.goalId]);
  await store.close();
});

test("history pages are stable, bounded, and reject malformed cursors or limits", async (t) => {
  const storageRoot = await tempRoot(t);
  const store = new WorkGoalStore({ storageRoot });
  await store.load();
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const goal = await store.create(input(`Goal ${index}`));
    ids.push(goal.goalId);
    await store.append({ goalId: goal.goalId, expectedVersion: 1, type: "work_goal_paused", payload: { actor: "user" } });
    await store.append({ goalId: goal.goalId, expectedVersion: 1, type: "work_goal_archived", payload: { actor: "user" } });
  }

  const ordered = [...ids].sort();
  const first = store.listHistoryPage({ limit: 2 });
  assert.deepEqual(first.items.map((goal) => goal.goalId), ordered.slice(0, 2));
  assert.equal(first.nextCursor, ordered[1]);
  const second = store.listHistoryPage({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((goal) => goal.goalId), ordered.slice(2));
  assert.equal(second.nextCursor, null);
  assert.throws(() => store.listHistoryPage({ limit: 0 }), { code: "invalid_history_page" });
  assert.throws(() => store.listHistoryPage({ limit: 101 }), { code: "invalid_history_page" });
  assert.throws(() => store.listHistoryPage({ cursor: "not-a-uuid" }), { code: "invalid_history_page" });
  assert.throws(() => store.listHistoryPage({ unexpected: true }), { code: "invalid_history_page" });
  await store.close();
});

test("concurrent amendments cannot both pass the same expected version", async (t) => {
  const storageRoot = await tempRoot(t);
  const store = new WorkGoalStore({ storageRoot });
  await store.load();
  const created = await store.create(input());
  const nextSpec = { ...created.spec, version: 2, objective: "Amended" };
  const amendment = { goalId: created.goalId, expectedVersion: 1, type: "work_goal_amended", payload: { spec: nextSpec } };
  const results = await Promise.allSettled([store.append(amendment), store.append(amendment)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected" && item.reason.code === "stale_goal_version").length, 1);
  assert.equal(store.getActive().spec.version, 2);
  await store.close();
  const recovered = new WorkGoalStore({ storageRoot });
  await recovered.load();
  assert.equal(recovered.getActive().spec.objective, "Amended");
  assert.equal(recovered.getActive().seq, 2);
  await recovered.close();
});

test("the project registry lock excludes another writer and close releases it", async (t) => {
  const storageRoot = await tempRoot(t);
  const first = new WorkGoalStore({ storageRoot });
  await first.load();
  const second = new WorkGoalStore({ storageRoot });
  await assert.rejects(() => second.load(), (error) => error.code === "writer_conflict");
  await first.close();
  await second.load();
  await second.close();
});

test("concurrent processes cannot reclaim a fresh registry lock as stale", async (t) => {
  const storageRoot = await tempRoot(t);
  const goalsRoot = path.join(storageRoot, "work-goals");
  await fsp.mkdir(goalsRoot, { mode: 0o700 });
  await fsp.writeFile(path.join(goalsRoot, "registry.lock"), JSON.stringify({
    pid: 2_000_000_000, token: "00000000-0000-4000-8000-000000000001", acquiredAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const workerSource = `
    const { WorkGoalStore } = require(${JSON.stringify(path.resolve(__dirname, "../main/harness/work-goal-store"))});
    const store = new WorkGoalStore({ storageRoot: process.argv[1] });
    store.load().then(() => {
      process.stdout.write(JSON.stringify({ loaded: true, pid: process.pid }) + '\\n');
      process.stdin.once('data', async () => { await store.close(); process.exit(0); });
    }, error => { process.stdout.write(JSON.stringify({ loaded: false, code: error.code }) + '\\n'); process.exit(0); });
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["-e", workerSource, storageRoot], {
    stdio: ["pipe", "pipe", "ignore"],
  }));
  t.after(() => Promise.all(children.map((child) => {
    if (child.exitCode === null) child.stdin.end("close");
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000).unref();
    });
  })));

  const outcomes = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline !== -1) {
        try { resolve(JSON.parse(output.slice(0, newline))); } catch (error) { reject(error); }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  })));
  const winners = outcomes.filter((outcome) => outcome.loaded);
  assert.equal(winners.length, 1);
  assert.ok(outcomes.filter((outcome) => !outcome.loaded).every((outcome) => outcome.code === "writer_conflict"));
  const finalOwner = JSON.parse(await fsp.readFile(path.join(goalsRoot, "registry.lock"), "utf8"));
  assert.equal(finalOwner.pid, winners[0].pid);
});

test("loading discards only an incomplete final line and keeps future appends valid", async (t) => {
  const storageRoot = await tempRoot(t);
  const first = new WorkGoalStore({ storageRoot });
  await first.load();
  const created = await first.create(input());
  await first.close();
  const journalPath = path.join(storageRoot, "work-goals", created.goalId, "events.jsonl");
  await fsp.appendFile(journalPath, '{"seq":2');

  const recovered = new WorkGoalStore({ storageRoot });
  await recovered.load();
  assert.equal(recovered.getActive().seq, 1);
  await recovered.append({ goalId: created.goalId, expectedVersion: 1, type: "work_goal_paused", payload: { actor: "user" } });
  assert.equal(recovered.getActive().status, "paused");
  const lines = (await fsp.readFile(journalPath, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).seq, 2);
  await recovered.close();
});

test("loading rejects corruption in a complete journal line", async (t) => {
  const storageRoot = await tempRoot(t);
  const first = new WorkGoalStore({ storageRoot });
  await first.load();
  const created = await first.create(input());
  await first.close();
  await fsp.appendFile(path.join(storageRoot, "work-goals", created.goalId, "events.jsonl"), "{}\n");
  const recovered = new WorkGoalStore({ storageRoot });
  await assert.rejects(() => recovered.load(), (error) => error.code === "storage_corrupt");
});

test("a mismatched or corrupt active pointer cannot replace journal-derived state", async (t) => {
  const storageRoot = await tempRoot(t);
  const first = new WorkGoalStore({ storageRoot });
  await first.load();
  const created = await first.create(input());
  await first.close();
  const pointerPath = path.join(storageRoot, "work-goals", "active.json");
  for (const bad of ['{"version":1,"activeGoalId":"00000000-0000-4000-8000-000000000000"}', "broken JSON"]) {
    await fsp.writeFile(pointerPath, bad);
    const recovered = new WorkGoalStore({ storageRoot });
    await recovered.load();
    assert.equal(recovered.getActive().goalId, created.goalId);
    await recovered.close();
  }
});

test("symlinked Work Goal storage paths are rejected without following them", async (t) => {
  const storageRoot = await tempRoot(t);
  const elsewhere = await tempRoot(t);
  await fsp.symlink(elsewhere, path.join(storageRoot, "work-goals"));
  const rootStore = new WorkGoalStore({ storageRoot });
  await assert.rejects(() => rootStore.load(), (error) => error.code === "unsafe_path");
  await fsp.unlink(path.join(storageRoot, "work-goals"));

  const first = new WorkGoalStore({ storageRoot });
  await first.load();
  const created = await first.create(input());
  await first.close();
  const journalPath = path.join(storageRoot, "work-goals", created.goalId, "events.jsonl");
  const savedPath = path.join(elsewhere, "journal.jsonl");
  await fsp.rename(journalPath, savedPath);
  await fsp.symlink(savedPath, journalPath);
  const recovered = new WorkGoalStore({ storageRoot });
  await assert.rejects(() => recovered.load(), (error) => error.code === "unsafe_path");
  assert.ok((await fsp.readFile(savedPath, "utf8")).includes("work_goal_created"));
});

test("append requires the expected version and leaves the journal unchanged on rejection", async (t) => {
  const storageRoot = await tempRoot(t);
  const store = new WorkGoalStore({ storageRoot });
  await store.load();
  const created = await store.create(input());
  const journalPath = path.join(storageRoot, "work-goals", created.goalId, "events.jsonl");
  const before = await fsp.readFile(journalPath, "utf8");
  await assert.rejects(
    () => store.append({ goalId: created.goalId, type: "work_goal_paused", payload: { actor: "user" } }),
    (error) => error.code === "invalid_field",
  );
  assert.equal(await fsp.readFile(journalPath, "utf8"), before);
  await store.close();
});

test("append snapshots caller payload before the serialized write begins", async (t) => {
  const storageRoot = await tempRoot(t);
  const store = new WorkGoalStore({ storageRoot });
  await store.load();
  const created = await store.create(input());
  const eventInput = {
    goalId: created.goalId,
    expectedVersion: 1,
    type: "work_goal_paused",
    payload: { actor: "user" },
  };
  const pending = store.append(eventInput);
  eventInput.payload.actor = "host";
  eventInput.type = "work_goal_archived";
  assert.equal((await pending).status, "paused");
  await store.close();
});

test("close waits for an in-flight initial load and releases its registry lock", async (t) => {
  const storageRoot = await tempRoot(t);
  const first = new WorkGoalStore({ storageRoot });
  const loading = first.load();
  const closing = first.close();
  await Promise.all([loading, closing]);

  const second = new WorkGoalStore({ storageRoot });
  await second.load();
  await second.close();
});
