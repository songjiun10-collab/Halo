"use strict";

const { createHash, randomUUID } = require("node:crypto") as typeof import("node:crypto");
// The Codex adapter is still JavaScript; only the helper used here is typed.
const { boundedUtf8 } = require("./providers/codex-mcp-adapter") as {
  boundedUtf8(value: string, max?: number): { text: string; truncated: boolean; sourceBytes: number };
};

type JsonObject = { [key: string]: unknown };
type SignalOptions = { signal?: AbortSignal };
interface McpConnection { id?: unknown; provider?: unknown; server?: unknown; status?: unknown; generation?: unknown }
interface McpTool { name?: unknown; description?: unknown; inputSchema?: unknown; connectorId?: unknown }
interface McpCallResult { content?: unknown; structuredContent?: unknown; isError?: unknown }
interface McpCallOptions {
  signal: AbortSignal; expectedSchema: unknown; expectedConnectorId: unknown; expectedGeneration: unknown;
}
// Backends are untrusted: every value they return is re-validated by the broker.
interface McpProvider {
  listConnections(options: { signal: AbortSignal }): unknown;
  listTools(connectionId: string, options: { signal: AbortSignal }): unknown;
  describeTool(connectionId: unknown, toolName: unknown, options: { signal: AbortSignal }): McpTool | null | undefined | Promise<McpTool | null | undefined>;
  call(connectionId: unknown, toolName: unknown, args: unknown, options: McpCallOptions): McpCallResult | null | undefined | Promise<McpCallResult | null | undefined>;
  close(): unknown;
}
interface ConnectionSummary { id: string; provider: unknown; server: unknown; status: unknown; generation: unknown }
interface CatalogConnection extends ConnectionSummary { backend: McpProvider }
interface ToolIdentity {
  connectionId: unknown; provider: unknown; server: unknown; generation: unknown; toolName: unknown; connectorId: unknown;
}
interface CallBinding extends ToolIdentity { schemaDigest: string; argsDigest: string; contextDigest: string }
interface ApprovalRequest extends CallBinding {
  context: unknown; arguments: unknown; risk: "unknown"; signal: AbortSignal;
}
interface ApprovalDecision { allowed?: unknown; kind?: unknown }
interface StoredApproval { binding: CallBinding; args: unknown; expiresAt: number }
interface BrokerOptions {
  providers?: McpProvider[];
  getContext?: () => unknown;
  validateArguments?: (schema: unknown, args: unknown) => unknown;
  requestApproval?: (request: ApprovalRequest) => ApprovalDecision | null | undefined | Promise<ApprovalDecision | null | undefined>;
  journal?: { append(event: JsonObject): unknown };
  now?: () => number;
  deadlineMs?: number;
}

class McpBrokerError extends Error {
  declare code: string;
  constructor(code: string) { super(`MCP broker: ${code}`); this.code = code; }
}
const MAX_ARGUMENT_BYTES = 16384;
const MAX_CONTEXT_BYTES = 4096;
const fail: (code: string) => never = (code) => { throw new McpBrokerError(code); };
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) fail("invalid_json");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, (v) => canonical(v, depth + 1)).join(",")}]`;
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.getOwnPropertySymbols(value).length) fail("invalid_json");
    return `{${Object.keys(value).sort().map((k) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, k)!;
      if (!Object.hasOwn(descriptor, "value")) fail("invalid_json");
      return `${JSON.stringify(k)}:${canonical(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  fail("invalid_json");
}
function snapshot<T = unknown>(value: unknown, limit: number, code = "invalid_json"): T {
  const json = canonical(value);
  if (Buffer.byteLength(json) > limit) fail(code);
  return JSON.parse(json);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function checkSchema(schema: unknown): unknown {
  const copy = snapshot(schema, MAX_ARGUMENT_BYTES, "unsupported_schema");
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    // First backend version rejects all references; it never fetches remote schemas.
    if (Object.hasOwn(node, "$ref")) fail("unsupported_schema");
    Object.values(node).forEach(walk);
  };
  walk(copy);
  return copy;
}

// Host-only foundation. No renderer route or model tool may mint approvals.
// journal/validation/approval callbacks must be wired by a trusted TaskHost.
class GenericMcpBroker {
  #approvals = new Map<string, StoredApproval>();
  #reviews = new Set<AbortController>();
  declare providers: McpProvider[];
  declare getContext: () => unknown;
  declare validateArguments: (schema: unknown, args: unknown) => unknown;
  declare requestApproval: NonNullable<BrokerOptions["requestApproval"]>;
  declare journal: { append(event: JsonObject): unknown };
  declare now: () => number;
  declare deadlineMs: number;
  declare busy: boolean;
  declare closed: boolean;
  declare active: AbortController | null;
  declare closing: Promise<unknown[]> | null;
  constructor({ providers, getContext, validateArguments, requestApproval, journal,
    now = Date.now, deadlineMs = 10000 }: BrokerOptions = {}) {
    if (!Array.isArray(providers) || providers.length > 8 || !providers.length ||
      [getContext, validateArguments, requestApproval, journal?.append].some((fn) => typeof fn !== "function") ||
      !Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60000) fail("invalid_config");
    Object.assign(this, { providers: [...providers], getContext, validateArguments, requestApproval, journal, now, deadlineMs });
    this.busy = false; this.closed = false; this.active = null; this.closing = null;
  }
  async _run<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (this.closed || callerSignal?.aborted) fail("cancelled");
    if (this.busy || this.closing) fail("busy");
    this.busy = true;
    const controller = this.active = new AbortController();
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.deadlineMs);
    try { return await this._bounded(() => operation(controller.signal), controller.signal); }
    finally {
      clearTimeout(timer); callerSignal?.removeEventListener("abort", abort);
      if (controller.signal.aborted) {
        this.closed = true;
        this._closeProviders().catch(() => {}); // Admission stays permanently shut even if teardown rejects.
      }
      this.busy = false; this.active = null;
    }
  }
  _closeProviders() {
    return this.closing ||= Promise.all(this.providers.map((p) => Promise.resolve().then(() => p.close())));
  }
  _bounded<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new McpBrokerError("cancelled"));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new McpBrokerError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => signal.aborted ? fail("cancelled") : operation()).then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async _connections(signal: AbortSignal): Promise<CatalogConnection[]> {
    const output: CatalogConnection[] = [], ids = new Set<string>();
    for (const provider of this.providers) {
      const connections = await this._bounded(() => provider.listConnections({ signal }), signal);
      if (!Array.isArray(connections) || connections.length > 64) fail("invalid_catalog");
      for (const connection of connections as McpConnection[]) {
        if (typeof connection.id !== "string" || connection.id.length > 256 || ids.has(connection.id)) fail("invalid_catalog");
        ids.add(connection.id);
        const summary = snapshot<ConnectionSummary>({ id: connection.id, provider: connection.provider, server: connection.server,
          status: connection.status, generation: connection.generation ?? 0 }, 2048, "invalid_catalog");
        output.push({ ...summary, backend: provider });
      }
    }
    return output;
  }
  async _target(connectionId: unknown, toolName: unknown, signal: AbortSignal) {
    const connection = (await this._connections(signal)).find((c) => c.id === connectionId);
    if (!connection || connection.status !== "connected") fail("connection_unavailable");
    const tool = await this._bounded(() => connection.backend.describeTool(connectionId, toolName, { signal }), signal);
    if (tool?.name !== toolName || typeof toolName !== "string" || toolName.length > 256) fail("tool_unavailable");
    // A matching string name proves the backend returned a tool object.
    const schema = checkSchema(tool!.inputSchema);
    const identity: ToolIdentity = { connectionId, provider: connection.provider, server: connection.server,
      generation: connection.generation, toolName, connectorId: tool!.connectorId ?? null };
    return { connection, schema, identity, schemaDigest: digest(schema) };
  }
  listConnections({ signal }: SignalOptions = {}) {
    return this._run(async (s) => (await this._connections(s)).map(({ backend, ...summary }) => summary), signal);
  }
  searchTools(query: unknown, { signal }: SignalOptions = {}) {
    if (typeof query !== "string" || Buffer.byteLength(query) > 1024) return Promise.reject(new McpBrokerError("invalid_query"));
    return this._run(async (s) => {
      const results: { connectionId: string; name: string; description: string; authority: "untrusted_connector" }[] = [];
      for (const connection of await this._connections(s)) {
        if (connection.status !== "connected") continue;
        const tools = await this._bounded(() => connection.backend.listTools(connection.id, { signal: s }), s);
        if (!Array.isArray(tools) || tools.length > 1000) fail("invalid_catalog");
        for (const tool of tools as McpTool[]) {
          if (typeof tool.name !== "string" || tool.name.length > 256) fail("invalid_catalog");
          if (!`${tool.name} ${tool.description || ""}`.toLowerCase().includes(query.toLowerCase())) continue;
          const entry = { connectionId: connection.id, name: tool.name, description: String(tool.description || "").slice(0, 240), authority: "untrusted_connector" as const };
          if (results.length === 10 || Buffer.byteLength(JSON.stringify([...results, entry])) > 4096) return results;
          results.push(entry);
        }
      }
      return results;
    }, signal);
  }
  describeTool(connectionId: unknown, toolName: unknown, { signal }: SignalOptions = {}) {
    return this._run(async (s) => {
      const target = await this._target(connectionId, toolName, s);
      return { ...target.identity, inputSchema: target.schema, schemaDigest: target.schemaDigest, authority: "untrusted_connector" };
    }, signal);
  }
  async proposeCall(request: unknown, { signal }: SignalOptions = {}) {
    if (this.#approvals.size >= 64 || this.#reviews.size >= 8) fail("capacity");
    const frozenRequest = snapshot<JsonObject>(request, 17408, "invalid_arguments");
    const prepared = await this._run(async (s) => {
      const args = snapshot(frozenRequest.arguments, MAX_ARGUMENT_BYTES, "invalid_arguments");
      const context = snapshot(this.getContext(), MAX_CONTEXT_BYTES);
      const target = await this._target(frozenRequest.connectionId, frozenRequest.toolName, s);
      if (await this.validateArguments(target.schema, snapshot(args, MAX_ARGUMENT_BYTES)) !== true) fail("invalid_arguments");
      const binding: CallBinding = { ...target.identity, schemaDigest: target.schemaDigest, argsDigest: digest(args), contextDigest: digest(context) };
      return { args, context, binding };
    }, signal);
    if (this.closed || signal?.aborted) fail("cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.#reviews.add(controller);
    try {
      const { args, context, binding } = prepared;
      // Waiting for a person does not run a worker and has no provider timer.
      const decision = await this._bounded(() => this.requestApproval({ ...binding, context: snapshot(context, MAX_CONTEXT_BYTES), arguments: snapshot(args, MAX_ARGUMENT_BYTES), risk: "unknown", signal: controller.signal }), controller.signal);
      // Unknown tools always require human approval in this foundation.
      if (decision?.allowed !== true || decision.kind !== "human") fail("approval_denied");
      if (this.closed || controller.signal.aborted) fail("cancelled");
      const id = randomUUID(), expiresAt = this.now() + 60000;
      this.#approvals.set(id, { binding, args, expiresAt });
      return { id, expiresAt, ...binding };
    } finally { this.#reviews.delete(controller); signal?.removeEventListener("abort", abort); }
  }
  dispatchApproved(id: unknown, { signal }: SignalOptions = {}) {
    const approval = this.#approvals.get(id as string);
    if (!approval) return Promise.reject(new McpBrokerError("invalid_approval"));
    return this._run(async (s) => {
      this.#approvals.delete(id as string); // Any attempted dispatch consumes this opaque capability.
      const startedAt = this.now();
      const { binding, args } = approval;
      // Expiry and context drift are rechecked at every await boundary before the call.
      const expired = () => this.now() >= approval.expiresAt || digest(this.getContext()) !== binding.contextDigest;
      const target = await this._target(binding.connectionId, binding.toolName, s);
      if (expired() ||
          digest(target.identity) !== digest(Object.fromEntries(Object.keys(target.identity).map((k) => [k, binding[k as keyof CallBinding]]))) ||
          target.schemaDigest !== binding.schemaDigest) fail("stale_approval");
      try { await this._bounded(() => this.journal.append({ type: "mcp_call_started", requestId: id, binding }), s); }
      catch { fail("journal_failed"); }
      if (expired()) fail("stale_approval");
      let result: McpCallResult | null | undefined;
      try {
        result = await this._bounded(() => {
          if (expired()) fail("stale_approval");
          return target.connection.backend.call(binding.connectionId, binding.toolName, snapshot(args, MAX_ARGUMENT_BYTES), {
            signal: s, expectedSchema: snapshot(target.schema, MAX_ARGUMENT_BYTES), expectedConnectorId: binding.connectorId,
            expectedGeneration: binding.generation,
          });
        }, s);
        if (!result || !Array.isArray(result.content) || Buffer.byteLength(JSON.stringify(result)) > 1048576) fail("invalid_result");
        const content = result.content as { type?: unknown; text?: unknown }[];
        const text = result.structuredContent != null ? canonical(result.structuredContent) :
          content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
        const compact = boundedUtf8(text);
        await this._bounded(() => this.journal.append({ type: "mcp_call_outcome", requestId: id, outcome: result!.isError ? "tool_error" : "ok", resultDigest: digest(result) }), s);
        return { ...compact, requestId: id, latencyMs: this.now() - startedAt,
          authority: "untrusted_connector", outcome: result.isError ? "tool_error" : "ok", source: binding };
      } catch { fail("execution_uncertain"); }
    }, signal).catch((error) => {
      if (error.code === "cancelled" && !this.#approvals.has(id as string)) throw new McpBrokerError("execution_uncertain");
      throw error;
    });
  }
  async close() {
    this.closed = true; this.active?.abort(); this.#approvals.clear();
    for (const controller of this.#reviews) controller.abort();
    await this._closeProviders();
  }
}

export = { GenericMcpBroker, McpBrokerError };
