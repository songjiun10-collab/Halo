// Generated from runtime-src/main/harness/mcp-schema-worker.ts. Do not edit; run npm run build:runtime.
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const Ajv = require("ajv");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
try {
    const Constructor = workerData.schema.$schema?.includes("2020-12") ? Ajv2020 : Ajv;
    const ajv = new Constructor({ allErrors: false, strictSchema: true, strictTypes: false,
        coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true,
        logger: false });
    addFormats(ajv, { mode: "fast" });
    const validate = ajv.compile(workerData.schema);
    parentPort.postMessage(validate(workerData.arguments) === true);
}
catch {
    parentPort.postMessage(false);
}
