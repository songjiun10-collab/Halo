"use strict";
const path = require("node:path");
const { Worker } = require("node:worker_threads");
let active = false;

function copy(value) {
  const visit = (v, depth = 0) => {
    if (depth > 32) throw Error("depth");
    if (v === null || ["boolean", "string"].includes(typeof v)) return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v))) throw Error("json");
    for (const key of Object.keys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!Object.hasOwn(descriptor, "value")) throw Error("getter");
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 16384) throw Error("size");
  return JSON.parse(json);
}
function validateMcpArguments(schema, args, { signal, timeoutMs = 500 } = {}) {
  if (signal?.aborted) return Promise.resolve(false);
  if (active) return Promise.reject(Object.assign(Error("schema worker busy"), { code: "busy" }));
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1000) return Promise.resolve(false);
  let data;
  try {
    data = { schema: copy(schema), arguments: copy(args) };
    const scan = (value) => {
      if (!value || typeof value !== "object") return;
      // Local refs also remain disabled until recursive-schema acceptance tests exist.
      if (Object.hasOwn(value, "$ref") || Object.hasOwn(value, "$async")) throw Error("ref");
      Object.values(value).forEach(scan);
    };
    scan(data.schema);
  } catch { return Promise.resolve(false); }
  active = true;
  return new Promise((resolve) => {
    let worker, timer, finished = false;
    const abort = () => finish(false);
    const finish = (result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      // The admission slot remains held until termination is confirmed.
      Promise.resolve(worker?.terminate()).catch(() => {}).then(() => { active = false; resolve(result === true); });
    };
    try {
      worker = new Worker(path.join(__dirname, "mcp-schema-worker.js"), { workerData: data, env: {},
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
      worker.once("message", finish);
      worker.once("error", () => finish(false));
      worker.once("exit", () => finish(false));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, timeoutMs);
      if (signal?.aborted) abort();
    } catch { finish(false); }
  });
}
module.exports = { validateMcpArguments };
