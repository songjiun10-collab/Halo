// Generated from runtime-src/main/harness/strategy-learning-store.ts. Do not edit; run npm run build:runtime.
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
const fs = __importStar(require("node:fs/promises"));
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const learning = require("./strategy-learning");
class StrategyLearningError extends Error {
    code;
    constructor(code, message) { super(message); this.name = "StrategyLearningError"; this.code = code; }
}
class StrategyLearningStore {
    directory;
    file;
    safeStorage;
    now;
    chain = Promise.resolve();
    constructor({ storageRoot, safeStorage, now }) {
        if (typeof storageRoot !== "string" || !storageRoot || !safeStorage)
            throw new StrategyLearningError("invalid_config", "secure local storage is required");
        this.directory = path.resolve(storageRoot);
        this.file = path.join(this.directory, "strategy-learning.enc");
        this.safeStorage = safeStorage;
        this.now = now || (() => new Date().toISOString());
    }
    assertEncryption() {
        if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === "basic_text")
            throw new StrategyLearningError("encryption_unavailable", "secure local encryption is unavailable");
    }
    async ensureDirectory() {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const st = await fs.lstat(this.directory);
        if (st.isSymbolicLink() || !st.isDirectory())
            throw new StrategyLearningError("unsafe_path", "learning directory must be a real directory");
        await fs.chmod(this.directory, 0o700);
    }
    async read() {
        this.assertEncryption();
        await this.ensureDirectory();
        let ciphertext;
        try {
            const handle = await fs.open(this.file, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
            try {
                ciphertext = await handle.readFile();
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error.code === "ENOENT")
                return structuredClone(learning.EMPTY_LEARNING);
            throw error;
        }
        try {
            return learning.validateLearningData(JSON.parse(this.safeStorage.decryptString(ciphertext)));
        }
        catch {
            throw new StrategyLearningError("learning_corrupt", "learning data could not be decrypted or validated");
        }
    }
    async write(value) {
        this.assertEncryption();
        await this.ensureDirectory();
        const ciphertext = this.safeStorage.encryptString(JSON.stringify(learning.validateLearningData(value)));
        if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length > 2_000_000)
            throw new StrategyLearningError("encryption_failed", "learning store output is invalid");
        try {
            const st = await fs.lstat(this.file);
            if (st.isSymbolicLink() || !st.isFile())
                throw new StrategyLearningError("unsafe_path", "learning file must be regular");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const temporary = path.join(this.directory, `.strategy-learning-${(0, node_crypto_1.randomUUID)()}.tmp`);
        const handle = await fs.open(temporary, node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(ciphertext);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        try {
            await fs.rename(temporary, this.file);
        }
        catch (error) {
            await fs.unlink(temporary).catch(() => undefined);
            throw error;
        }
    }
    mutate(fn) {
        const operation = this.chain.then(async () => { const outcome = fn(await this.read()); await this.write(outcome.data); return outcome.result; });
        this.chain = operation.catch(() => undefined);
        return operation;
    }
    async snapshot() { await this.chain; return this.read(); }
    async activeGuidance(modelId) {
        if (modelId !== "gpt-6-luna")
            return null;
        const data = await this.snapshot();
        if (!data.enabled || !data.activeRevisionId)
            return null;
        return data.revisions.find((r) => r.id === data.activeRevisionId)?.agentMd ?? null;
    }
    setEnabled(enabled) {
        if (typeof enabled !== "boolean")
            throw new StrategyLearningError("invalid_setting", "enabled must be boolean");
        return this.mutate((data) => ({ data: { ...data, enabled }, result: { ...data, enabled } }));
    }
    recordEpisode(input) {
        const episode = learning.makeEpisode(input);
        if (!episode)
            return Promise.resolve(false);
        return this.mutate((data) => {
            if (!data.enabled || data.episodes.some((e) => e.id === episode.id))
                return { data, result: false };
            const episodes = [...data.episodes, episode].slice(-500);
            const derived = learning.deriveCandidates(episodes, this.now());
            const existing = new Set(data.candidates.map((c) => c.id));
            const candidates = [...data.candidates, ...derived.filter((c) => !existing.has(c.id))].slice(-100);
            return { data: { ...data, episodes, candidates }, result: true };
        });
    }
    evaluate(candidateId) {
        return this.mutate((data) => {
            if (!data.enabled)
                throw new StrategyLearningError("learning_disabled", "enable learning before evaluating candidates");
            const candidate = data.candidates.find((c) => c.id === candidateId);
            if (!candidate || candidate.status === "candidate" && candidate.support < 3)
                throw new StrategyLearningError("candidate_not_ready", "candidate does not have enough evidence");
            const active = data.activeRevisionId ? data.revisions.find((r) => r.id === data.activeRevisionId)?.strategyIds ?? [] : [];
            const evaluation = learning.evaluateCandidate(candidate, active);
            const candidates = data.candidates.map((item) => item.id === candidateId ? { ...item, evaluation, status: evaluation.result === "inconclusive" ? "inconclusive" : "evaluated" } : item);
            const next = { ...data, candidates };
            return { data: next, result: next };
        });
    }
    promote(candidateId, expectedActiveRevisionId) {
        return this.mutate((data) => {
            if (!data.enabled)
                throw new StrategyLearningError("learning_disabled", "enable learning before promoting guidance");
            if (data.activeRevisionId !== expectedActiveRevisionId)
                throw new StrategyLearningError("stale_revision", "active revision changed; refresh before promoting");
            const candidate = data.candidates.find((c) => c.id === candidateId);
            if (!candidate?.evaluation || candidate.evaluation.result !== "pass")
                throw new StrategyLearningError("evaluation_required", "a passing replay evaluation is required");
            const active = data.activeRevisionId ? data.revisions.find((r) => r.id === data.activeRevisionId)?.strategyIds ?? [] : [];
            const fresh = learning.evaluateCandidate(candidate, active);
            if (fresh.digest !== candidate.evaluation.digest || fresh.result !== "pass")
                throw new StrategyLearningError("evaluation_stale", "replay evaluation no longer matches");
            const id = (0, node_crypto_1.randomUUID)();
            const strategyIds = [...new Set([...active, candidate.strategyId])];
            const revision = { id, parentId: data.activeRevisionId, candidateId, strategyIds, agentMd: learning.renderAgentMd(strategyIds, id), createdAt: this.now(), event: "promote" };
            const next = { ...data, revisions: [...data.revisions, revision].slice(-100), activeRevisionId: id };
            return { data: next, result: next };
        });
    }
    rollback(targetRevisionId, expectedActiveRevisionId) {
        return this.mutate((data) => {
            if (!data.enabled || data.activeRevisionId !== expectedActiveRevisionId)
                throw new StrategyLearningError("stale_revision", "learning is disabled or active revision changed");
            const target = targetRevisionId === "builtin" ? { strategyIds: [] } : data.revisions.find((r) => r.id === targetRevisionId);
            if (!target || targetRevisionId === data.activeRevisionId)
                throw new StrategyLearningError("invalid_rollback", "target must be a prior known revision or built-in baseline");
            const id = (0, node_crypto_1.randomUUID)();
            const strategyIds = [...target.strategyIds];
            const revision = { id, parentId: data.activeRevisionId, candidateId: null, strategyIds, agentMd: learning.renderAgentMd(strategyIds, id), createdAt: this.now(), event: "rollback" };
            const next = { ...data, revisions: [...data.revisions, revision].slice(-100), activeRevisionId: id };
            return { data: next, result: next };
        });
    }
    clear() { return this.mutate((data) => ({ data: { ...structuredClone(learning.EMPTY_LEARNING), enabled: data.enabled }, result: true })); }
}
module.exports = { StrategyLearningError, StrategyLearningStore };
