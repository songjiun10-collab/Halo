"use strict";
const contracts = require("../../../shared/harness-contracts");
const { normalizeUsage } = require("../../../shared/usage");
const { buildPrompt, buildRoomPrompt, isRoomTurn, parseRoomTurn, parseAndValidateProposal, stripCodeFence, MAX_CLI_STDOUT_BYTES } = require("./claude-code-bridge");
const { DEFAULT_NVIDIA_MODEL, isNvidiaModel } = require("./nvidia-models");
const { getModelPromptGuidance } = require("./model-prompt-guidance");
const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const failure = (code) => Object.assign(new Error(`NVIDIA planner: ${code}`), { code });

class NvidiaPlannerBridge {
  constructor({ apiKey = process.env.NVIDIA_API_KEY, model = DEFAULT_NVIDIA_MODEL, fetchFn = globalThis.fetch, timeoutMs = 55000 } = {}) {
    if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw failure("authentication_failed");
    if (!isNvidiaModel(model)) throw failure("invalid_model");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 55000) throw failure("invalid_config");
    this._apiKey = apiKey; this._model = model; this._fetch = fetchFn; this._timeoutMs = timeoutMs;
    this._pending = null; this._abort = null; this._usage = null; this._closed = false;
  }
  isBusy() { return this._pending !== null; }
  takeUsage() { const usage = this._usage; this._usage = null; return usage; }
  async start(context, { signal } = {}) {
    if (this._closed) throw failure("closed");
    if (this.isBusy()) throw failure("busy");
    if (!contracts.isPlainObject(context)) throw failure("invalid_field");
    if (signal?.aborted) throw failure("cancelled");
    const room = isRoomTurn(context);
    const promptGuidance = getModelPromptGuidance("nvidia", this._model, context.progress?.plannerEffort);
    const prompt = room ? buildRoomPrompt(context, promptGuidance) : buildPrompt(context, promptGuidance);
    const body = JSON.stringify({ model: this._model, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 8192 });
    if (Buffer.byteLength(body) > contracts.MAX_PLANNER_FRAME_BYTES) throw failure("invalid_field");
    const controller = new AbortController(); this._abort = controller; this._usage = null;
    const cancel = () => controller.abort(failure("cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(failure("timeout")), this._timeoutMs);
    const started = performance.now();
    // Defer until _pending has been assigned, including synchronous fetch errors.
    const pending = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const response = await this._fetch(ENDPOINT, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${this._apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(response.status === 401 || response.status === 403 ? "authentication_failed" : response.status === 429 ? "rate_limited" : "http_error");
      }
      if (!response.body) throw failure("invalid_response");
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_CLI_STDOUT_BYTES) { controller.abort(failure("output_too_large")); throw failure("output_too_large"); }
        chunks.push(Buffer.from(chunk));
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("invalid_response"); }
      const choice = data?.choices?.[0];
      if (!Array.isArray(data?.choices) || data.choices.length !== 1 || choice.finish_reason !== "stop" || choice.message?.role !== "assistant"
        || typeof choice.message.content !== "string" || choice.message.tool_calls?.length || choice.message.function_call || choice.message.refusal) throw failure("invalid_response");
      const text = stripCodeFence(choice.message.content);
      const proposal = room ? parseRoomTurn(text) : parseAndValidateProposal(text);
      this._usage = normalizeUsage("nvidia", { usage: data.usage, duration_ms: performance.now() - started });
      return proposal;
    }).catch((error) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const safeCodes = ["authentication_failed", "rate_limited", "http_error", "invalid_response", "output_too_large", "invalid_proposal", "invalid_proposal_json"];
      throw failure(safeCodes.includes(error?.code) ? error.code : "network_error");
    }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      this._pending = null; this._abort = null;
    });
    this._pending = pending;
    return pending;
  }
  cancel() { this._abort?.abort(failure("cancelled")); }
  async close() { this._closed = true; this.cancel(); await this._pending?.catch(() => {}); }
}
module.exports = { NvidiaPlannerBridge };
