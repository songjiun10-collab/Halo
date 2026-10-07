"use strict";

interface MemoryResult { entries: unknown[] }
interface ReadOptions {
  loadMemory?: () => MemoryResult | Promise<MemoryResult>;
  recallActivity?: () => unknown | Promise<unknown>;
}

// Start exactly two independent context sources. Do not merge, cache, retry or
// authorize anything here. The controller retains its epoch checks and merges
// required memory, branch results, then optional activity in that order.
function startTurnMemoryReads({ loadMemory, recallActivity }: ReadOptions): {
  memory: Promise<unknown[]>; activity: Promise<unknown[]>;
} {
  const memory = Promise.resolve().then(async () => loadMemory ? (await loadMemory()).entries : []);
  // Attach the optional rejection handler immediately: this may fail while
  // required memory is still pending, or after that required read has failed.
  const activity = Promise.resolve().then(() => recallActivity?.())
    .then((result) => Array.isArray(result) ? result : []).catch(() => []);
  return { memory, activity };
}

export = { startTurnMemoryReads };
