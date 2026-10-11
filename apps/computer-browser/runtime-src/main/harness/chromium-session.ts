import events = require("node:events");

interface SessionContext { transport: { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> }; contextId: string }
type Cookie = Record<string, any>;
class CdpSession extends events.EventEmitter {
  readonly cookies;
  readonly webRequest = { onBeforeRequest: (_filter: unknown, _listener: unknown) => { /* The CDP page applies the request filter before navigation. */ } };
  constructor(private readonly getContext: () => Promise<SessionContext>) {
    super();
    this.cookies = {
      set: async (cookie: Cookie) => {
        const url = new URL(cookie.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw new Error("invalid_cookie");
        const { transport, contextId } = await this.getContext();
        const sameSite = ({ lax: "Lax", strict: "Strict", no_restriction: "None" } as Record<string, string>)[cookie.sameSite];
        const value = { name: cookie.name, value: cookie.value, url: url.href, path: cookie.path ?? "/", secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
          ...(cookie.domain ? { domain: cookie.domain } : {}), ...(sameSite ? { sameSite } : {}), ...(Number.isFinite(cookie.expirationDate) ? { expires: cookie.expirationDate } : {}) };
        await transport.send("Storage.setCookies", { cookies: [value], browserContextId: contextId });
      },
      get: async (filter: Cookie = {}) => {
        const { transport, contextId } = await this.getContext();
        const { cookies } = await transport.send("Storage.getCookies", { browserContextId: contextId });
        return (cookies as Cookie[]).filter((cookie) => (!filter.name || cookie.name === filter.name) && (!filter.domain || cookie.domain === filter.domain))
          .map((cookie) => ({ ...cookie, expirationDate: cookie.expires, sameSite: ({ Lax: "lax", Strict: "strict", None: "no_restriction" } as Record<string, string>)[cookie.sameSite] ?? "unspecified" }));
      },
      remove: async (url: string, name: string) => {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid_cookie_url");
        const { transport, contextId } = await this.getContext();
        const { cookies } = await transport.send("Storage.getCookies", { browserContextId: contextId });
        const matches = (cookies as Cookie[]).filter((cookie) => cookie.name === name && (parsed.hostname === cookie.domain.replace(/^\./, "") || parsed.hostname.endsWith(cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`)) && parsed.pathname.startsWith(cookie.path));
        if (!matches.length) return;
        const { targetId } = await transport.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
        try {
          const { sessionId } = await transport.send("Target.attachToTarget", { targetId, flatten: true });
          for (const cookie of matches) await transport.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path, ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}) }, sessionId);
        } finally { await transport.send("Target.closeTarget", { targetId }); }
      },
    };
  }
  setPermissionRequestHandler(_handler: unknown): void { /* CDP denies the permissions before any page request. */ }
  setPermissionCheckHandler(_handler: unknown): void { /* Same browser-level deny policy. */ }
  async clearStorageData(): Promise<void> {
    const { transport, contextId } = await this.getContext();
    const { targetInfos = [] } = await transport.send("Target.getTargets");
    const targets = targetInfos.filter((target: Record<string, any>) => target.browserContextId === contextId &&
      ["page", "service_worker", "shared_worker", "worker"].includes(target.type));
    const attached: { sessionId: string; target: Record<string, any> }[] = [];
    const origins = new Set<string>();
    const addOrigin = (value: unknown) => {
      if (typeof value !== "string") return;
      try {
        const parsed = new URL(value);
        if (["http:", "https:"].includes(parsed.protocol)) origins.add(parsed.origin);
      } catch { /* non-web documents own no website storage */ }
    };
    try {
      for (const target of targets) {
        addOrigin(target.url);
        try {
          const { sessionId } = await transport.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          if (typeof sessionId !== "string" || !sessionId) continue;
          attached.push({ sessionId, target });
          if (target.type === "page") {
            const { frameTree } = await transport.send("Page.getFrameTree", {}, sessionId);
            const visit = (frame: Record<string, any> | undefined) => {
              if (!frame) return;
              addOrigin(frame.url);
              for (const child of frame.childFrames ?? []) visit(child);
            };
            visit(frameTree?.frame);
          }
        } catch { /* a target closing during enumeration has no live storage to clear */ }
      }
      await transport.send("Storage.clearCookies", { browserContextId: contextId });
      const storageSession = attached[0]?.sessionId;
      if (storageSession) {
        for (const origin of origins) await transport.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }, storageSession);
      }
    } finally {
      await Promise.allSettled(attached.map(({ sessionId }) => transport.send("Target.detachFromTarget", { sessionId })));
    }
  }
}
export = { CdpSession };
