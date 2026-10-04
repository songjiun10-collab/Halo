"use strict";

// Message boundary between the coordinator and its browser/planner. Every
// message is plain JSON so the far side can later live in another process;
// the loopback transport enforces that by round-tripping through JSON.

type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };
interface RequestSpec { signalArg?: number }
interface PortSpec<Method extends string = string> {
  requests: Record<Method, RequestSpec>;
  notifications: readonly string[];
  events: readonly string[];
}
type BrowserMethod = "observe" | "execute" | "userNavigate" | "fillCredential" | "dispose";
type PlannerMethod = "next" | "close";
interface MirroredState { documentEpoch?: unknown; snapshot?: unknown; [key: string]: unknown }
interface ErrorFields { code?: unknown; message?: unknown }
// These fields describe the existing protocol access patterns. The transport
// accepts unknown input and JSON-copies it; interpreting a received frame does
// not add validation or change the handling of malformed JSON messages.
interface PortMessage {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: ErrorFields | null;
  state?: MirroredState | null;
  name?: unknown;
  snapshot?: unknown;
}
type MessageHandler = (message: PortMessage) => void;
type CloseHandler = () => void;
interface Transport {
  send(message: unknown): void;
  onMessage(handler: MessageHandler): void;
  onClose(handler: CloseHandler): void;
  close(): void;
}
interface LoopbackEnd extends Transport {
  _inbox: PortMessage[];
  _handler: MessageHandler | null;
  _closeHandlers: CloseHandler[];
  _closed: boolean;
  _scheduled: boolean;
  _schedule(): void;
}
interface ClientOptions { defaultTimeoutMs?: number; timeouts?: Record<string, number> }
interface CallOptions { signal?: AbortSignal; timeoutMs?: number }
interface FinishOptions { cancel?: boolean }
type CallEnvelope = { ok: true; result: unknown } | { ok: false; code: unknown; message: unknown };
interface PendingCall { finish(envelope: CallEnvelope, options?: FinishOptions): void }
interface EventValues { state: MirroredState; change: unknown }
type EventName = keyof EventValues;
type EventListener<Name extends EventName> = (value: EventValues[Name]) => void;
type EventListeners = { [Name in EventName]: Set<EventListener<Name>> };
type LocalMethod = (...args: unknown[]) => unknown;
interface LocalPeer {
  [method: string]: unknown;
  getDocumentEpoch?: () => unknown;
  getBrowserSnapshot?: () => unknown;
  onChange?: (listener: (snapshot: unknown) => void) => (() => unknown) | null | undefined;
}
type RemoteMethod = (...args: unknown[]) => Promise<unknown>;

const { BROWSER_PORT, PLANNER_PORT } = require("../../shared/port-contracts") as {
  BROWSER_PORT: PortSpec<BrowserMethod>;
  PLANNER_PORT: PortSpec<PlannerMethod>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

class PortError extends Error {
  declare code: unknown;
  constructor(code: unknown, message?: unknown) {
    super((message || code) as string);
    this.name = "PortError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Rejects what JSON.stringify would silently distort. Object properties whose
// value is undefined are dropped by JSON and accepted here.
function assertJsonClean(value: unknown, path = "$", ancestors: unknown[] = []): void {
  const bad: (why: string) => never = (why) => { throw new PortError("non_serializable", `${path}: ${why}`); };
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) bad("number is not finite"); return; }
  if (value === undefined) bad("undefined");
  if (typeof value !== "object") bad(typeof value);
  if (ancestors.includes(value)) bad("circular reference");
  const next = [...ancestors, value];
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index: number) => assertJsonClean(item, `${path}[${index}]`, next));
    return;
  }
  if (!isPlainObject(value)) bad(`non-plain object (${value.constructor?.name ?? "unknown"})`);
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) assertJsonClean(item, `${path}.${key}`, next);
  }
}

function jsonCopy(message: unknown): JsonValue {
  assertJsonClean(message);
  return JSON.parse(JSON.stringify(message)) as JsonValue;
}

function createLoopbackPair(): [LoopbackEnd, LoopbackEnd] {
  const ends: LoopbackEnd[] = [];
  const makeEnd = (index: number): LoopbackEnd => {
    const end: LoopbackEnd = {
      _inbox: [],
      _handler: null,
      _closeHandlers: [],
      _closed: false,
      _scheduled: false,
      send(message) {
        if (end._closed) throw new PortError("peer_closed", "transport is closed");
        const copy = jsonCopy(message);
        const peer = ends[1 - index];
        peer._inbox.push(copy as PortMessage);
        peer._schedule();
      },
      onMessage(handler) {
        end._handler = handler;
        end._schedule();
      },
      onClose(handler) {
        end._closeHandlers.push(handler);
        if (end._closed) setImmediate(handler);
      },
      close() {
        if (end._closed) return;
        for (const side of ends) {
          side._closed = true;
          setImmediate(() => { for (const handler of side._closeHandlers) handler(); });
        }
      },
      _schedule() {
        if (end._scheduled || !end._handler) return;
        end._scheduled = true;
        setImmediate(() => {
          end._scheduled = false;
          while (end._inbox.length > 0 && end._handler) end._handler(end._inbox.shift()!);
        });
      },
    };
    return end;
  };
  ends.push(makeEnd(0), makeEnd(1));
  return ends as [LoopbackEnd, LoopbackEnd];
}

class PortClient {
  declare _transport: Transport;
  declare _defaultTimeoutMs: number;
  declare _timeouts: Record<string, number>;
  declare _pending: Map<unknown, PendingCall>;
  declare _listeners: EventListeners;
  declare _nextId: number;
  declare _closed: boolean;

  constructor(transport: Transport, { defaultTimeoutMs = DEFAULT_TIMEOUT_MS, timeouts = {} }: ClientOptions = {}) {
    this._transport = transport;
    this._defaultTimeoutMs = defaultTimeoutMs;
    this._timeouts = timeouts;
    this._pending = new Map();
    this._listeners = { state: new Set(), change: new Set() };
    this._nextId = 1;
    this._closed = false;
    transport.onMessage((message) => this._handle(message));
    transport.onClose(() => this._closeAll());
  }

  on<Name extends EventName>(name: Name, listener: EventListener<Name>) {
    (this._listeners[name] as Set<EventListener<Name>>).add(listener);
    return () => (this._listeners[name] as Set<EventListener<Name>>).delete(listener);
  }

  notify(method: string, args: unknown[] = []): void {
    if (this._closed) return;
    try {
      this._transport.send({ type: "notify", method, params: jsonCopy(args) });
    } catch {
      // Fire-and-forget: a notification that cannot be delivered is dropped.
    }
  }

  call(method: string, args: unknown[] = [], { signal, timeoutMs }: CallOptions = {}): Promise<CallEnvelope> {
    if (this._closed) return Promise.resolve({ ok: false, code: "peer_closed", message: "transport is closed" });
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "aborted", message: "call was aborted" });
    try {
      args = jsonCopy(args) as JsonValue[];
    } catch (error) {
      return Promise.resolve({ ok: false, code: (error as ErrorFields).code || "non_serializable", message: (error as ErrorFields).message });
    }
    const id = `r${this._nextId++}`;
    return new Promise<CallEnvelope>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onAbort: (() => void) | null = null;
      const finish = (envelope: CallEnvelope, { cancel = false }: FinishOptions = {}) => {
        if (!this._pending.delete(id)) return;
        clearTimeout(timer!);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        if (cancel) this._send({ type: "cancel", id });
        resolve(envelope);
      };
      this._pending.set(id, { finish });
      const methodTimeout = Object.hasOwn(this._timeouts, method) ? this._timeouts[method] : undefined;
      const limit = timeoutMs ?? methodTimeout ?? this._defaultTimeoutMs;
      timer = setTimeout(() => finish({ ok: false, code: "timeout", message: `${method} timed out after ${limit}ms` }, { cancel: true }), limit);
      if (signal) {
        onAbort = () => finish({ ok: false, code: "aborted", message: "call was aborted" }, { cancel: true });
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (!this._send({ type: "request", id, method, params: args })) {
        finish({ ok: false, code: "peer_closed", message: "transport is closed" });
      }
    });
  }

  close(): void {
    this._transport.close();
  }

  _send(message: unknown): boolean {
    try { this._transport.send(message); return true; } catch { return false; }
  }

  _handle(message: PortMessage): void {
    if (message.type === "reply") {
      const pending = this._pending.get(message.id);
      if (message.state) this._emit("state", message.state);
      if (!pending) return;
      pending.finish(message.ok
        ? { ok: true, result: message.result ?? null }
        : { ok: false, code: message.error?.code || "remote_error", message: message.error?.message || "" });
    } else if (message.type === "state") {
      this._emit("state", message.state as MirroredState);
    } else if (message.type === "event" && message.name === "change") {
      if (message.state) this._emit("state", message.state);
      this._emit("change", message.snapshot);
    }
  }

  _emit<Name extends EventName>(name: Name, value: EventValues[Name]): void {
    for (const listener of [...this._listeners[name] as Set<EventListener<Name>>]) {
      try { listener(value); } catch { /* a listener must not break the port */ }
    }
  }

  _closeAll(): void {
    this._closed = true;
    for (const { finish } of [...this._pending.values()]) {
      finish({ ok: false, code: "peer_closed", message: "peer closed the transport" });
    }
  }
}

function errorEnvelope(error: unknown) {
  return { code: typeof (error as ErrorFields | null | undefined)?.code === "string" ? (error as ErrorFields).code : "remote_error", message: String((error as ErrorFields | null | undefined)?.message ?? error) };
}

function servePort(local: LocalPeer, transport: Transport, spec: PortSpec, { mirrorState = false } = {}) {
  const inflight = new Map<unknown, AbortController>();
  let closed = false;

  const send = (message: unknown) => {
    if (closed) return;
    try { transport.send(message); } catch { /* peer went away */ }
  };

  const getState = (): MirroredState | undefined => {
    if (!mirrorState) return undefined;
    const state: MirroredState = {};
    try {
      if (typeof local.getDocumentEpoch === "function") state.documentEpoch = local.getDocumentEpoch();
      if (typeof local.getBrowserSnapshot === "function") state.snapshot = local.getBrowserSnapshot();
      const clean = jsonCopy(state) as MirroredState;
      return Object.keys(clean).length > 0 ? clean : undefined;
    } catch {
      return undefined;
    }
  };

  const withState = (message: PortMessage) => {
    const state = getState();
    return state ? { ...message, state } : message;
  };

  const handleRequest = async ({ id, method, params }: PortMessage) => {
    if (typeof id !== "string") return;
    if (typeof method !== "string" || !Object.hasOwn(spec.requests, method)) {
      return send({ type: "reply", id, ok: false, error: { code: "unknown_method", message: `unknown method ${String(method)}` } });
    }
    if (typeof local[method] !== "function") {
      return send({ type: "reply", id, ok: false, error: { code: "unsupported_method", message: `${method} is not supported by this peer` } });
    }
    const controller = new AbortController();
    inflight.set(id, controller);
    const args: unknown[] = Array.isArray(params) ? [...params] : [];
    const { signalArg } = spec.requests[method];
    if (signalArg !== undefined) {
      while (args.length < signalArg) args.push(undefined);
      args[signalArg] = { ...(isPlainObject(args[signalArg]) ? args[signalArg] : {}), signal: controller.signal };
    }
    let reply: PortMessage;
    try {
      const result = await (local[method] as LocalMethod)(...args);
      const value = jsonCopy(result === undefined ? null : result);
      reply = { type: "reply", id, ok: true, result: value };
    } catch (error) {
      reply = { type: "reply", id, ok: false, error: errorEnvelope(error) };
    }
    if (inflight.delete(id)) send(withState(reply));
  };

  transport.onMessage((message) => {
    if (message.type === "request") {
      handleRequest(message);
    } else if (message.type === "cancel") {
      const controller = inflight.get(message.id);
      if (controller) { inflight.delete(message.id); controller.abort(); }
    } else if (message.type === "notify") {
      if (!spec.notifications.includes(message.method as string) || typeof local[message.method as string] !== "function") return;
      const params: unknown[] = Array.isArray(message.params) ? message.params : [];
      try {
        Promise.resolve((local[message.method as string] as LocalMethod)(...params)).catch(() => {});
      } catch {
        // Fire-and-forget: the far side never learns about a failed notification.
      }
    }
  });

  let unsubscribe: (() => unknown) | null | undefined = null;
  if (spec.events.includes("onChange") && typeof local.onChange === "function") {
    unsubscribe = local.onChange((snapshot) => {
      let clean: JsonValue;
      try {
        clean = jsonCopy(snapshot);
      } catch {
        return;
      }
      send(withState({ type: "event", name: "change", snapshot: clean }));
    });
  }
  const initial = getState();
  if (initial) send({ type: "state", state: initial });

  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    },
  };
}

function serveBrowser(browser: LocalPeer, transport: Transport) {
  return servePort(browser, transport, BROWSER_PORT, { mirrorState: true });
}

function servePlanner(planner: LocalPeer, transport: Transport) {
  return servePort(planner, transport, PLANNER_PORT);
}

function stripSignal(args: unknown[], signalArg?: number) {
  const out = [...args];
  let signal: AbortSignal | undefined;
  if (signalArg !== undefined && out[signalArg] && typeof out[signalArg] === "object") {
    const { signal: s, ...rest } = out[signalArg] as { signal?: AbortSignal; [key: string]: unknown };
    signal = s;
    out[signalArg] = rest;
  }
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return { args: out, signal };
}

function requestMethods<Method extends string>(client: PortClient, spec: PortSpec<Method>): Record<Method, RemoteMethod> {
  const methods = {} as Record<Method, RemoteMethod>;
  for (const [name, { signalArg }] of Object.entries(spec.requests) as [Method, RequestSpec][]) {
    methods[name] = async (...rawArgs: unknown[]) => {
      const { args, signal } = stripSignal(rawArgs, signalArg);
      const envelope = await client.call(name, args, { signal });
      if (!envelope.ok) throw new PortError(envelope.code, envelope.message);
      return envelope.result;
    };
  }
  return methods;
}

function createRemoteBrowser(transport: Transport, options?: ClientOptions) {
  const client = new PortClient(transport, options);
  const state: MirroredState = { documentEpoch: undefined, snapshot: undefined };
  client.on("state", (next) => {
    if ("documentEpoch" in next) state.documentEpoch = next.documentEpoch;
    if ("snapshot" in next) state.snapshot = next.snapshot;
  });
  const listeners = new Set<EventListener<"change">>();
  client.on("change", (snapshot) => {
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* listener errors stay local */ }
    }
  });
  return {
    ...requestMethods(client, BROWSER_PORT),
    setPermissionMode: (mode: unknown) => client.notify("setPermissionMode", [mode]),
    getBrowserSnapshot: () => state.snapshot,
    // NaN never equals an observation's epoch, so an unknown epoch forces a
    // fresh observe instead of reusing a possibly stale one.
    getDocumentEpoch: () => (state.documentEpoch === undefined ? NaN : state.documentEpoch),
    onChange: (listener: EventListener<"change">) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closePort: () => client.close(),
  };
}

function createRemotePlanner(transport: Transport, options?: ClientOptions) {
  const client = new PortClient(transport, options);
  return {
    ...requestMethods(client, PLANNER_PORT),
    warm: () => client.notify("warm", []),
    closePort: () => client.close(),
  };
}

export = {
  PortError,
  PortClient,
  assertJsonClean,
  createLoopbackPair,
  serveBrowser,
  servePlanner,
  createRemoteBrowser,
  createRemotePlanner,
};
