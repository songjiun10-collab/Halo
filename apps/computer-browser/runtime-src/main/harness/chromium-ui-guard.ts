interface UiTransport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(callback: (method: string, params: Record<string, any>, sessionId?: string) => void): () => void;
}

function installChromiumUiGuard(transport: UiTransport, options: { origin: string; sessionId: string; targetId: string }): () => void {
  const origin = new URL(options.origin).origin;
  const listener = (method: string, params: Record<string, any>, sessionId?: string) => {
    if (method === "Target.targetCreated" && params.targetInfo?.openerId === options.targetId) {
      void transport.send("Target.closeTarget", { targetId: params.targetInfo.targetId }).catch(() => undefined);
      return;
    }
    // A stray default window (Dock reopen, Cmd+N) would cover Halo; close it and bring Halo back.
    if (method === "Target.targetCreated" && params.targetInfo?.type === "page" && /^chrome:\/\/newtab\/?/.test(params.targetInfo.url ?? "")) {
      void transport.send("Target.closeTarget", { targetId: params.targetInfo.targetId })
        .then(() => transport.send("Target.activateTarget", { targetId: options.targetId }))
        .catch(() => undefined);
      return;
    }
    if (method !== "Fetch.requestPaused" || sessionId !== options.sessionId) return;
    let allowed = false;
    try { allowed = new URL(params.request?.url).origin === origin; } catch { /* malformed document URL fails closed */ }
    if (allowed) void transport.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId).catch(() => undefined);
    else void transport.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
  };
  return transport.onEvent(listener);
}

export = { installChromiumUiGuard };
