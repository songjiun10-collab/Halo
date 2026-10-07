// Generated from runtime-src/main/harness/chromium-session.ts. Do not edit; run npm run build:runtime.
"use strict";
const events = require("node:events");
class CdpSession extends events.EventEmitter {
    getContext;
    cookies;
    webRequest = { onBeforeRequest: (_filter, _listener) => { } };
    constructor(getContext) {
        super();
        this.getContext = getContext;
        this.cookies = {
            set: async (cookie) => {
                const url = new URL(cookie.url);
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || typeof cookie.name !== "string" || typeof cookie.value !== "string")
                    throw new Error("invalid_cookie");
                const { transport, contextId } = await this.getContext();
                const sameSite = { lax: "Lax", strict: "Strict", no_restriction: "None" }[cookie.sameSite];
                const value = { name: cookie.name, value: cookie.value, url: url.href, path: cookie.path ?? "/", secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
                    ...(cookie.domain ? { domain: cookie.domain } : {}), ...(sameSite ? { sameSite } : {}), ...(Number.isFinite(cookie.expirationDate) ? { expires: cookie.expirationDate } : {}) };
                await transport.send("Storage.setCookies", { cookies: [value], browserContextId: contextId });
            },
            get: async (filter = {}) => {
                const { transport, contextId } = await this.getContext();
                const { cookies } = await transport.send("Storage.getCookies", { browserContextId: contextId });
                return cookies.filter((cookie) => (!filter.name || cookie.name === filter.name) && (!filter.domain || cookie.domain === filter.domain))
                    .map((cookie) => ({ ...cookie, expirationDate: cookie.expires, sameSite: { Lax: "lax", Strict: "strict", None: "no_restriction" }[cookie.sameSite] ?? "unspecified" }));
            },
            remove: async (url, name) => {
                const parsed = new URL(url);
                if (!["http:", "https:"].includes(parsed.protocol))
                    throw new Error("invalid_cookie_url");
                const { transport, contextId } = await this.getContext();
                const { cookies } = await transport.send("Storage.getCookies", { browserContextId: contextId });
                const matches = cookies.filter((cookie) => cookie.name === name && (parsed.hostname === cookie.domain.replace(/^\./, "") || parsed.hostname.endsWith(cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`)) && parsed.pathname.startsWith(cookie.path));
                if (!matches.length)
                    return;
                const { targetId } = await transport.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
                try {
                    const { sessionId } = await transport.send("Target.attachToTarget", { targetId, flatten: true });
                    for (const cookie of matches)
                        await transport.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path, ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}) }, sessionId);
                }
                finally {
                    await transport.send("Target.closeTarget", { targetId });
                }
            },
        };
    }
    setPermissionRequestHandler(_handler) { }
    setPermissionCheckHandler(_handler) { }
    async clearStorageData() { const { transport, contextId } = await this.getContext(); await transport.send("Storage.clearCookies", { browserContextId: contextId }); }
}
module.exports = { CdpSession };
