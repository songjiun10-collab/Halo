// Generated from runtime-src/main/harness/turn-memory-preparation.ts. Do not edit; run npm run build:runtime.
"use strict";
// Start exactly two independent context sources. Do not merge, cache, retry or
// authorize anything here. The controller retains its epoch checks and merges
// required memory, branch results, then optional activity in that order.
function startTurnMemoryReads({ loadMemory, recallActivity }) {
    const memory = Promise.resolve().then(async () => loadMemory ? (await loadMemory()).entries : []);
    // Attach the optional rejection handler immediately: this may fail while
    // required memory is still pending, or after that required read has failed.
    const activity = Promise.resolve().then(() => recallActivity?.())
        .then((result) => Array.isArray(result) ? result : []).catch(() => []);
    return { memory, activity };
}
module.exports = { startTurnMemoryReads };
