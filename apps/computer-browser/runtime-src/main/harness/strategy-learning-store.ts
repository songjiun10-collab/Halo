"use strict";

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import learning = require("./strategy-learning");

interface SafeStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string }
interface StoreOptions { storageRoot: string; safeStorage: SafeStorage; now?: () => string }
type StoredData = ReturnType<typeof learning.validateLearningData>;

class StrategyLearningError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "StrategyLearningError"; this.code = code; }
}

class StrategyLearningStore {
  private directory: string;
  private file: string;
  private safeStorage: SafeStorage;
  private now: () => string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor({ storageRoot, safeStorage, now }: StoreOptions) {
    if (typeof storageRoot !== "string" || !storageRoot || !safeStorage) throw new StrategyLearningError("invalid_config", "secure local storage is required");
    this.directory = path.resolve(storageRoot);
    this.file = path.join(this.directory, "strategy-learning.enc");
    this.safeStorage = safeStorage;
    this.now = now || (() => new Date().toISOString());
  }

  private assertEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new StrategyLearningError("encryption_unavailable", "secure local encryption is unavailable");
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(this.directory);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new StrategyLearningError("unsafe_path", "learning directory must be a real directory");
    await fs.chmod(this.directory, 0o700);
  }

  private async read(): Promise<StoredData> {
    this.assertEncryption(); await this.ensureDirectory();
    let ciphertext: Buffer;
    try {
      const handle = await fs.open(this.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { ciphertext = await handle.readFile(); } finally { await handle.close(); }
    } catch (error: any) { if (error.code === "ENOENT") return structuredClone(learning.EMPTY_LEARNING); throw error; }
    try { return learning.validateLearningData(JSON.parse(this.safeStorage.decryptString(ciphertext))) as StoredData; }
    catch { throw new StrategyLearningError("learning_corrupt", "learning data could not be decrypted or validated"); }
  }

  private async write(value: StoredData): Promise<void> {
    this.assertEncryption(); await this.ensureDirectory();
    const ciphertext = this.safeStorage.encryptString(JSON.stringify(learning.validateLearningData(value)));
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length > 2_000_000) throw new StrategyLearningError("encryption_failed", "learning store output is invalid");
    try { const st = await fs.lstat(this.file); if (st.isSymbolicLink() || !st.isFile()) throw new StrategyLearningError("unsafe_path", "learning file must be regular"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(this.directory, `.strategy-learning-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, this.file); } catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  }

  private mutate<T>(fn: (data: StoredData) => { data: StoredData; result: T }): Promise<T> {
    const operation = this.chain.then(async () => { const outcome = fn(await this.read()); await this.write(outcome.data); return outcome.result; });
    this.chain = operation.catch(() => undefined);
    return operation as Promise<T>;
  }

  async snapshot(): Promise<StoredData> { await this.chain; return this.read(); }
  async activeGuidance(modelId: string): Promise<string | null> {
    if (modelId !== "gpt-6-luna") return null;
    const data = await this.snapshot();
    if (!data.enabled || !data.activeRevisionId) return null;
    return data.revisions.find((r) => r.id === data.activeRevisionId)?.agentMd ?? null;
  }

  setEnabled(enabled: boolean): Promise<StoredData> {
    if (typeof enabled !== "boolean") throw new StrategyLearningError("invalid_setting", "enabled must be boolean");
    return this.mutate((data) => ({ data: { ...data, enabled }, result: { ...data, enabled } }));
  }

  recordEpisode(input: Parameters<typeof learning.makeEpisode>[0]): Promise<boolean> {
    const episode = learning.makeEpisode(input);
    if (!episode) return Promise.resolve(false);
    return this.mutate((data) => {
      if (!data.enabled || data.episodes.some((e) => e.id === episode.id)) return { data, result: false };
      const episodes = [...data.episodes, episode].slice(-500);
      const derived = learning.deriveCandidates(episodes, this.now());
      const existing = new Set(data.candidates.map((c) => c.id));
      const candidates = [...data.candidates, ...derived.filter((c) => !existing.has(c.id))].slice(-100);
      return { data: { ...data, episodes, candidates }, result: true };
    });
  }

  evaluate(candidateId: string): Promise<StoredData> {
    return this.mutate((data) => {
      if (!data.enabled) throw new StrategyLearningError("learning_disabled", "enable learning before evaluating candidates");
      const candidate = data.candidates.find((c) => c.id === candidateId);
      if (!candidate || candidate.status === "candidate" && candidate.support < 3) throw new StrategyLearningError("candidate_not_ready", "candidate does not have enough evidence");
      const active = data.activeRevisionId ? data.revisions.find((r) => r.id === data.activeRevisionId)?.strategyIds ?? [] : [];
      const evaluation = learning.evaluateCandidate(candidate, active);
      const candidates = data.candidates.map((item) => item.id === candidateId ? { ...item, evaluation, status: evaluation.result === "inconclusive" ? "inconclusive" as const : "evaluated" as const } : item);
      const next = { ...data, candidates };
      return { data: next, result: next };
    });
  }

  promote(candidateId: string, expectedActiveRevisionId: string | null): Promise<StoredData> {
    return this.mutate((data) => {
      if (!data.enabled) throw new StrategyLearningError("learning_disabled", "enable learning before promoting guidance");
      if (data.activeRevisionId !== expectedActiveRevisionId) throw new StrategyLearningError("stale_revision", "active revision changed; refresh before promoting");
      const candidate = data.candidates.find((c) => c.id === candidateId);
      if (!candidate?.evaluation || candidate.evaluation.result !== "pass") throw new StrategyLearningError("evaluation_required", "a passing replay evaluation is required");
      const active = data.activeRevisionId ? data.revisions.find((r) => r.id === data.activeRevisionId)?.strategyIds ?? [] : [];
      const fresh = learning.evaluateCandidate(candidate, active);
      if (fresh.digest !== candidate.evaluation.digest || fresh.result !== "pass") throw new StrategyLearningError("evaluation_stale", "replay evaluation no longer matches");
      const id = randomUUID();
      const strategyIds = [...new Set([...active, candidate.strategyId])];
      const revision = { id, parentId: data.activeRevisionId, candidateId, strategyIds, agentMd: learning.renderAgentMd(strategyIds, id), createdAt: this.now(), event: "promote" as const };
      const next = { ...data, revisions: [...data.revisions, revision].slice(-100), activeRevisionId: id };
      return { data: next, result: next };
    });
  }

  rollback(targetRevisionId: string, expectedActiveRevisionId: string | null): Promise<StoredData> {
    return this.mutate((data) => {
      if (!data.enabled || data.activeRevisionId !== expectedActiveRevisionId) throw new StrategyLearningError("stale_revision", "learning is disabled or active revision changed");
      const target = targetRevisionId === "builtin" ? { strategyIds: [] as StoredData["revisions"][number]["strategyIds"] } : data.revisions.find((r) => r.id === targetRevisionId);
      if (!target || targetRevisionId === data.activeRevisionId) throw new StrategyLearningError("invalid_rollback", "target must be a prior known revision or built-in baseline");
      const id = randomUUID();
      const strategyIds: StoredData["revisions"][number]["strategyIds"] = [...target.strategyIds];
      const revision = { id, parentId: data.activeRevisionId, candidateId: null, strategyIds, agentMd: learning.renderAgentMd(strategyIds, id), createdAt: this.now(), event: "rollback" as const };
      const next = { ...data, revisions: [...data.revisions, revision].slice(-100), activeRevisionId: id };
      return { data: next, result: next };
    });
  }

  clear(): Promise<boolean> { return this.mutate((data) => ({ data: { ...structuredClone(learning.EMPTY_LEARNING), enabled: data.enabled }, result: true })); }
}

export = { StrategyLearningError, StrategyLearningStore };
