"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createSlackTaskEntry } = require("../main/harness/slack-task-entry");

const SECRET = "0123456789abcdef0123";
const NOW = 1_800_000_000_000;

function signed(fields, { secret = SECRET, ts = Math.floor(NOW / 1000) } = {}) {
  const rawBody = new URLSearchParams({ team_id: "T1", user_id: "U1", channel_id: "C1", ...fields }).toString();
  const sig = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
  return { rawBody, headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig }, nowMs: NOW };
}

function make(extra = {}) {
  const started = [];
  const entry = createSlackTaskEntry({
    signingSecret: SECRET, allowedTeamIds: ["T1"], allowedUserIds: ["U1"], target: { agentId: "agent-1" },
    startTask: async (input) => { started.push(input); return { taskId: "t" }; }, ...extra,
  });
  return { entry, started };
}

test("a valid signed command from an allowlisted user starts one task", async () => {
  const { entry, started } = make();
  const reply = await entry.handle(signed({ text: "  find flights  " }));
  assert.equal(reply.status, 200);
  assert.deepEqual(started, [{ agentId: "agent-1", request: "find flights" }]);
});

test("bad, missing, stale or oversized signed requests are 401 and start nothing", async () => {
  const { entry, started } = make();
  const good = signed({ text: "x" });
  assert.equal((await entry.handle({ ...good, headers: { ...good.headers, "x-slack-signature": "v0=00" } })).status, 401);
  assert.equal((await entry.handle({ ...good, headers: {} })).status, 401);
  assert.equal((await entry.handle(signed({ text: "x" }, { secret: "another-secret-value-xx" }))).status, 401);
  assert.equal((await entry.handle(signed({ text: "x" }, { ts: Math.floor(NOW / 1000) - 600 }))).status, 401);
  const big = signed({ text: "x".repeat(9000) });
  assert.equal((await entry.handle(big)).status, 401);
  assert.equal(started.length, 0);
});

test("workspace, user and (when set) channel must all be allowlisted, without saying which failed", async () => {
  const { entry, started } = make({ allowedChannelIds: ["C1"] });
  const replies = [];
  for (const fields of [{ team_id: "T9" }, { user_id: "U9" }, { channel_id: "C9" }]) replies.push(await entry.handle(signed({ text: `hi ${Object.keys(fields)[0]}`, ...fields })));
  assert.equal(new Set(replies.map((r) => r.body.text)).size, 1);
  assert.equal(started.length, 0);
});

test("a replayed signed request is accepted once", async () => {
  const { entry, started } = make();
  const request = signed({ text: "once" });
  await entry.handle(request);
  await entry.handle(request);
  assert.equal(started.length, 1);
});

test("empty and over-long text are refused; rate limit is per user", async () => {
  const { entry, started } = make({ maxPerUserPerMinute: 2, maxRequestChars: 20 });
  await entry.handle(signed({ text: "   " }));
  await entry.handle(signed({ text: "y".repeat(21) }));
  assert.equal(started.length, 0);
  await entry.handle(signed({ text: "a" }));
  await entry.handle(signed({ text: "b" }));
  const limited = await entry.handle(signed({ text: "c" }));
  assert.equal(started.length, 2);
  assert.match(limited.body.text, /Too many/);
});

test("a startTask failure is reported without leaking the error", async () => {
  const { entry } = make({ startTask: async () => { throw new Error("secret detail"); } });
  const reply = await entry.handle(signed({ text: "go" }));
  assert.equal(reply.body.text, "The task could not be started.");
});

test("construction fails closed on missing secret, empty allowlists or ambiguous target", () => {
  const ok = { signingSecret: SECRET, allowedTeamIds: ["T1"], allowedUserIds: ["U1"], target: { agentId: "a" }, startTask: async () => {} };
  assert.doesNotThrow(() => createSlackTaskEntry(ok));
  assert.throws(() => createSlackTaskEntry({ ...ok, signingSecret: "short" }), TypeError);
  assert.throws(() => createSlackTaskEntry({ ...ok, allowedUserIds: [] }), TypeError);
  assert.throws(() => createSlackTaskEntry({ ...ok, allowedTeamIds: ["bad id"] }), TypeError);
  assert.throws(() => createSlackTaskEntry({ ...ok, target: { agentId: "a", teamId: "t" } }), TypeError);
  assert.throws(() => createSlackTaskEntry({ ...ok, allowedChannelIds: [] }), TypeError);
});
