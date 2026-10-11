// Generated from runtime-src/main/harness/chromium-ui-guard.ts. Do not edit; run npm run build:runtime.
"use strict";
function installChromiumUiGuard(transport, options) {
    const origin = new URL(options.origin).origin;
    const listener = (method, params, sessionId) => {
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
        if (method !== "Fetch.requestPaused" || sessionId !== options.sessionId)
            return;
        let allowed = false;
        try {
            allowed = new URL(params.request?.url).origin === origin;
        }
        catch { /* malformed document URL fails closed */ }
        if (allowed)
            void transport.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId).catch(() => undefined);
        else
            void transport.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
    };
    return transport.onEvent(listener);
}
module.exports = { installChromiumUiGuard };
