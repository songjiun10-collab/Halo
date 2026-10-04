"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseModelIds, fetchNvidiaModelIds, NVIDIA_MODELS_ENDPOINT } = require("../main/harness/nvidia-model-catalog");
const { isNvidiaModel, setDiscoveredNvidiaModels, listNvidiaModels, NVIDIA_MODELS } = require("../main/harness/providers/nvidia-models");

const body = (value) => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from(typeof value === "string" ? value : JSON.stringify(value)); })() });

test("parseModelIds keeps well-formed chat ids, dedupes, and drops embeddings and junk", () => {
  const ids = parseModelIds({ data: [{ id: "meta/llama-4" }, { id: "meta/llama-4" }, { id: "nvidia/nv-embedqa-e5" }, { id: "../etc/passwd" }, { id: 7 }, null, { id: "no-slash" }] });
  assert.deepEqual(ids, ["meta/llama-4"]);
  assert.throws(() => parseModelIds({}), { code: "invalid_response" });
});

test("fetch goes only to the fixed endpoint, with the key, and refuses redirects", async () => {
  let seen;
  const ids = await fetchNvidiaModelIds({ apiKey: "k", fetchFn: async (url, init) => { seen = { url, init }; return body({ data: [{ id: "a/b" }] }); } });
  assert.deepEqual(ids, ["a/b"]);
  assert.equal(seen.url, NVIDIA_MODELS_ENDPOINT);
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.headers.Authorization, "Bearer k");
});

test("fetch maps failures to stable codes without leaking the key", async () => {
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "" }), { code: "authentication_failed" });
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "k", fetchFn: async () => ({ ok: false, status: 401 }) }), { code: "authentication_failed" });
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "k", fetchFn: async () => ({ ok: false, status: 429 }) }), { code: "rate_limited" });
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "k", fetchFn: async () => body("not json") }), { code: "invalid_response" });
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "k", fetchFn: async () => { throw new Error("boom secret-k"); } }), (e) => e.code === "network_error" && !e.message.includes("secret"));
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "k", timeoutMs: 5, fetchFn: (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("x")))) }), { code: "timeout" });
  const huge = { ok: true, status: 200, body: (async function* () { yield Buffer.alloc(1024 * 1024 + 1); })() };
  await assert.rejects(fetchNvidiaModelIds({ apiKey: "k", fetchFn: async () => huge }), { code: "invalid_response" });
});

test("discovered ids extend the allowlist without replacing built-ins", () => {
  try {
    assert.equal(isNvidiaModel("meta/llama-4"), false);
    setDiscoveredNvidiaModels(["meta/llama-4", NVIDIA_MODELS[0].id]);
    assert.equal(isNvidiaModel("meta/llama-4"), true);
    const list = listNvidiaModels();
    assert.equal(list.filter((m) => m.id === NVIDIA_MODELS[0].id).length, 1);
    assert.deepEqual(list.at(-1), { id: "meta/llama-4", label: "meta/llama-4", discovered: true });
  } finally { setDiscoveredNvidiaModels([]); }
  assert.equal(isNvidiaModel("meta/llama-4"), false);
});
