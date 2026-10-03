// Generated from runtime-src/main/harness/message-port.ts. Do not edit; run npm run build:runtime.
"use strict";
const { BROWSER_PORT, PLANNER_PORT } = require("../../shared/port-contracts");
const DEFAULT_TIMEOUT_MS = 60_000;
class PortError extends Error {
    constructor(code, message) {
        super((message || code));
        this.name = "PortError";
        this.code = code;
    }
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object")
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
// Rejects what JSON.stringify would silently distort. Object properties whose
// value is undefined are dropped by JSON and accepted here.
function assertJsonClean(value, path = "$", ancestors = []) {
    const bad = (why) => { throw new PortError("non_serializable", `${path}: ${why}`); };
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            bad("number is not finite");
        return;
    }
    if (value === undefined)
        bad("undefined");
    if (typeof value !== "object")
        bad(typeof value);
    if (ancestors.includes(value))
        bad("circular reference");
    const next = [...ancestors, value];
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonClean(item, `${path}[${index}]`, next));
        return;
    }
    if (!isPlainObject(value))
        bad(`non-plain object (${value.constructor?.name ?? "unknown"})`);
    for (const [key, item] of Object.entries(value)) {
        if (item !== undefined)
            assertJsonClean(item, `${path}.${key}`, next);
    }
}
function jsonCopy(message) {
    assertJsonClean(message);
    return JSON.parse(JSON.stringify(message));
}
function createLoopbackPair() {
    const ends = [];
    const makeEnd = (index) => {
        const end = {
            _inbox: [],
            _handler: null,
            _closeHandlers: [],
            _closed: false,
            _scheduled: false,
            send(message) {
                if (end._closed)
                    throw new PortError("peer_closed", "transport is closed");
                const copy = jsonCopy(message);
                const peer = ends[1 - index];
                peer._inbox.push(copy);
                peer._schedule();
            },
            onMessage(handler) {
                end._handler = handler;
                end._schedule();
            },
            onClose(handler) {
                end._closeHandlers.push(handler);
                if (end._closed)
                    setImmediate(handler);
            },
            close() {
                if (end._closed)
                    return;
                for (const side of ends) {
                    side._closed = true;
                    setImmediate(() => { for (const handler of side._closeHandlers)
                        handler(); });
                }
            },
            _schedule() {
                if (end._scheduled || !end._handler)
                    return;
                end._scheduled = true;
                setImmediate(() => {
                    end._scheduled = false;
                    while (end._inbox.length > 0 && end._handler)
                        end._handler(end._inbox.shift());
                });
            },
        };
        return end;
    };
    ends.push(makeEnd(0), makeEnd(1));
    return ends;
}
class PortClient {
    constructor(transport, { defaultTimeoutMs = DEFAULT_TIMEOUT_MS, timeouts = {} } = {}) {
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
    on(name, listener) {
        this._listeners[name].add(listener);
        return () => this._listeners[name].delete(listener);
    }
    notify(method, args = []) {
        if (this._closed)
            return;
        try {
            this._transport.send({ type: "notify", method, params: jsonCopy(args) });
        }
        catch {
            // Fire-and-forget: a notification that cannot be delivered is dropped.
        }
    }
    call(method, args = [], { signal, timeoutMs } = {}) {
        if (this._closed)
            return Promise.resolve({ ok: false, code: "peer_closed", message: "transport is closed" });
        if (signal?.aborted)
            return Promise.resolve({ ok: false, code: "aborted", message: "call was aborted" });
        try {
            args = jsonCopy(args);
        }
        catch (error) {
            return Promise.resolve({ ok: false, code: error.code || "non_serializable", message: error.message });
        }
        const id = `r${this._nextId++}`;
        return new Promise((resolve) => {
            let timer = null;
            let onAbort = null;
            const finish = (envelope, { cancel = false } = {}) => {
                if (!this._pending.delete(id))
                    return;
                clearTimeout(timer);
                if (signal && onAbort)
                    signal.removeEventListener("abort", onAbort);
                if (cancel)
                    this._send({ type: "cancel", id });
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
    close() {
        this._transport.close();
    }
    _send(message) {
        try {
            this._transport.send(message);
            return true;
        }
        catch {
            return false;
        }
    }
    _handle(message) {
        if (message.type === "reply") {
            const pending = this._pending.get(message.id);
            if (message.state)
                this._emit("state", message.state);
            if (!pending)
                return;
            pending.finish(message.ok
                ? { ok: true, result: message.result ?? null }
                : { ok: false, code: message.error?.code || "remote_error", message: message.error?.message || "" });
        }
        else if (message.type === "state") {
            this._emit("state", message.state);
        }
        else if (message.type === "event" && message.name === "change") {
            if (message.state)
                this._emit("state", message.state);
            this._emit("change", message.snapshot);
        }
    }
    _emit(name, value) {
        for (const listener of [...this._listeners[name]]) {
            try {
                listener(value);
            }
            catch { /* a listener must not break the port */ }
        }
    }
    _closeAll() {
        this._closed = true;
        for (const { finish } of [...this._pending.values()]) {
            finish({ ok: false, code: "peer_closed", message: "peer closed the transport" });
        }
    }
}
function errorEnvelope(error) {
    return { code: typeof error?.code === "string" ? error.code : "remote_error", message: String(error?.message ?? error) };
}
function servePort(local, transport, spec, { mirrorState = false } = {}) {
    const inflight = new Map();
    let closed = false;
    const send = (message) => {
        if (closed)
            return;
        try {
            transport.send(message);
        }
        catch { /* peer went away */ }
    };
    const getState = () => {
        if (!mirrorState)
            return undefined;
        const state = {};
        try {
            if (typeof local.getDocumentEpoch === "function")
                state.documentEpoch = local.getDocumentEpoch();
            if (typeof local.getBrowserSnapshot === "function")
                state.snapshot = local.getBrowserSnapshot();
            const clean = jsonCopy(state);
            return Object.keys(clean).length > 0 ? clean : undefined;
        }
        catch {
            return undefined;
        }
    };
    const withState = (message) => {
        const state = getState();
        return state ? { ...message, state } : message;
    };
    const handleRequest = async ({ id, method, params }) => {
        if (typeof id !== "string")
            return;
        if (typeof method !== "string" || !Object.hasOwn(spec.requests, method)) {
            return send({ type: "reply", id, ok: false, error: { code: "unknown_method", message: `unknown method ${String(method)}` } });
        }
        if (typeof local[method] !== "function") {
            return send({ type: "reply", id, ok: false, error: { code: "unsupported_method", message: `${method} is not supported by this peer` } });
        }
        const controller = new AbortController();
        inflight.set(id, controller);
        const args = Array.isArray(params) ? [...params] : [];
        const { signalArg } = spec.requests[method];
        if (signalArg !== undefined) {
            while (args.length < signalArg)
                args.push(undefined);
            args[signalArg] = { ...(isPlainObject(args[signalArg]) ? args[signalArg] : {}), signal: controller.signal };
        }
        let reply;
        try {
            const result = await local[method](...args);
            const value = jsonCopy(result === undefined ? null : result);
            reply = { type: "reply", id, ok: true, result: value };
        }
        catch (error) {
            reply = { type: "reply", id, ok: false, error: errorEnvelope(error) };
        }
        if (inflight.delete(id))
            send(withState(reply));
    };
    transport.onMessage((message) => {
        if (message.type === "request") {
            handleRequest(message);
        }
        else if (message.type === "cancel") {
            const controller = inflight.get(message.id);
            if (controller) {
                inflight.delete(message.id);
                controller.abort();
            }
        }
        else if (message.type === "notify") {
            if (!spec.notifications.includes(message.method) || typeof local[message.method] !== "function")
                return;
            const params = Array.isArray(message.params) ? message.params : [];
            try {
                Promise.resolve(local[message.method](...params)).catch(() => { });
            }
            catch {
                // Fire-and-forget: the far side never learns about a failed notification.
            }
        }
    });
    let unsubscribe = null;
    if (spec.events.includes("onChange") && typeof local.onChange === "function") {
        unsubscribe = local.onChange((snapshot) => {
            let clean;
            try {
                clean = jsonCopy(snapshot);
            }
            catch {
                return;
            }
            send(withState({ type: "event", name: "change", snapshot: clean }));
        });
    }
    const initial = getState();
    if (initial)
        send({ type: "state", state: initial });
    return {
        close() {
            if (closed)
                return;
            closed = true;
            unsubscribe?.();
            for (const controller of inflight.values())
                controller.abort();
            inflight.clear();
        },
    };
}
function serveBrowser(browser, transport) {
    return servePort(browser, transport, BROWSER_PORT, { mirrorState: true });
}
function servePlanner(planner, transport) {
    return servePort(planner, transport, PLANNER_PORT);
}
function stripSignal(args, signalArg) {
    const out = [...args];
    let signal;
    if (signalArg !== undefined && out[signalArg] && typeof out[signalArg] === "object") {
        const { signal: s, ...rest } = out[signalArg];
        signal = s;
        out[signalArg] = rest;
    }
    while (out.length > 0 && out[out.length - 1] === undefined)
        out.pop();
    return { args: out, signal };
}
function requestMethods(client, spec) {
    const methods = {};
    for (const [name, { signalArg }] of Object.entries(spec.requests)) {
        methods[name] = async (...rawArgs) => {
            const { args, signal } = stripSignal(rawArgs, signalArg);
            const envelope = await client.call(name, args, { signal });
            if (!envelope.ok)
                throw new PortError(envelope.code, envelope.message);
            return envelope.result;
        };
    }
    return methods;
}
function createRemoteBrowser(transport, options) {
    const client = new PortClient(transport, options);
    const state = { documentEpoch: undefined, snapshot: undefined };
    client.on("state", (next) => {
        if ("documentEpoch" in next)
            state.documentEpoch = next.documentEpoch;
        if ("snapshot" in next)
            state.snapshot = next.snapshot;
    });
    const listeners = new Set();
    client.on("change", (snapshot) => {
        for (const listener of [...listeners]) {
            try {
                listener(snapshot);
            }
            catch { /* listener errors stay local */ }
        }
    });
    return {
        ...requestMethods(client, BROWSER_PORT),
        setPermissionMode: (mode) => client.notify("setPermissionMode", [mode]),
        getBrowserSnapshot: () => state.snapshot,
        // NaN never equals an observation's epoch, so an unknown epoch forces a
        // fresh observe instead of reusing a possibly stale one.
        getDocumentEpoch: () => (state.documentEpoch === undefined ? NaN : state.documentEpoch),
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        closePort: () => client.close(),
    };
}
function createRemotePlanner(transport, options) {
    const client = new PortClient(transport, options);
    return {
        ...requestMethods(client, PLANNER_PORT),
        warm: () => client.notify("warm", []),
        closePort: () => client.close(),
    };
}
module.exports = {
    PortError,
    PortClient,
    assertJsonClean,
    createLoopbackPair,
    serveBrowser,
    servePlanner,
    createRemoteBrowser,
    createRemotePlanner,
};
