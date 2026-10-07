"use strict";

// Measures context source preparation only. No external models/user data.
// Questions: does overlap help real file reads, and are outputs unchanged?
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { LocalMemoryStore } = require("../main/harness/local-memory-store");
const { ActivityJournalStore } = require("../main/harness/activity-journal-store");
const { startTurnMemoryReads } = require("../main/harness/turn-memory-preparation");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-turn-memory-bench-"));
  // Ephemeral AES-GCM for fixture files, NOT a replacement for OS safeStorage.
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "benchmark-ephemeral-aes-gcm",
    encryptString: (text: string) => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString: (data: Buffer) => {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  try {
    const memory = new LocalMemoryStore({ storageRoot: root, safeStorage });
    const activity = new ActivityJournalStore({ storageRoot: root, safeStorage });
    for (let i = 0; i < 20; i++) {
      await memory.put({ id: `fixture-${i}`, text: `Keep local research result ${i} concise`, origin: null });
      await activity.record({ url: `https://example.test/research/${i}`, title: `Research ${i}`, excerpt: `Local research fixture ${i}`, hasSensitiveField: false });
    }
    const rows = [];
    for (const delayMs of [0, 40]) {
      const samples: Record<string, number[]> = { sequential: [], parallel: [] };
      let identicalPairs = 0;
      const run = async (mode: string) => {
        const loadMemory = async () => { if (delayMs) await sleep(delayMs); return memory.forContext("https://example.test/"); };
        const recallActivity = async () => { if (delayMs) await sleep(delayMs); return activity.recall("research"); };
        const start = performance.now();
        let result;
        if (mode === "sequential") {
          // Frozen former ordering; both source implementations are real.
          const required = await loadMemory();
          result = [required.entries, await recallActivity()];
        } else {
          const reads = startTurnMemoryReads({ loadMemory, recallActivity });
          result = [await reads.memory, await reads.activity];
        }
        return { elapsedMs: performance.now() - start, result };
      };
      await run("sequential"); await run("parallel");
      for (let pair = 0; pair < 24; pair++) {
        const results: Record<string, any> = {};
        for (const mode of pair % 2 ? ["parallel", "sequential"] : ["sequential", "parallel"]) {
          results[mode] = await run(mode);
          samples[mode].push(results[mode].elapsedMs);
        }
        if (JSON.stringify(results.sequential.result) !== JSON.stringify(results.parallel.result)) throw new Error("context_sources_diverged");
        identicalPairs++;
      }
      const stats = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return { count: values.length, p50Ms: sorted[11], p95Ms: sorted[22] };
      };
      rows.push({ fixture: delayMs ? "local-files-plus-40ms-per-source" : "local-files-no-injected-delay", identicalPairs,
        sequential: stats(samples.sequential), parallel: stats(samples.parallel) });
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, rows,
      limits: ["Source preparation only, not model or task E2E latency.", "Ephemeral AES fixture, not macOS Keychain latency.", "Injected delays are synthetic and reported separately from real-file timings."] }, null, 2) + "\n");
  } finally {
    key.fill(0);
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
