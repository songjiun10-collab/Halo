"use strict";
const { parentPort, workerData } = require("node:worker_threads") as typeof import("node:worker_threads");
const Ajv = require("ajv") as typeof import("ajv").default;
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;
try {
  const Constructor = workerData.schema.$schema?.includes("2020-12") ? Ajv2020 : Ajv;
  const ajv = new Constructor({ allErrors: false, strictSchema: true, strictTypes: false,
    coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true,
    logger: false });
  addFormats(ajv, { mode: "fast" });
  const validate = ajv.compile(workerData.schema);
  parentPort!.postMessage(validate(workerData.arguments) === true);
} catch { parentPort!.postMessage(false); }
