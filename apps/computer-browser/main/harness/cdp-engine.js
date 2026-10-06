// Generated from runtime-src/main/harness/cdp-engine.ts. Do not edit; run npm run build:runtime.
"use strict";
// Browser-engine switch for the agent viewport host. While the engine is
// "electron" (the default) createPage() returns null and the host keeps its
// Electron path untouched. When the user selects "chromium", pages come from a
// Chromium they brought themselves (cdp-browser-host.ts), one isolated
// browser context per Agent partition, all over one shared connection.
const hostModule = require("./cdp-browser-host");
const pageModule = require("./cdp-web-contents");
// Under the "shared" policy only ordinary task pages (no saved login, no throwaway
// child profile) fall into one browser context; agent profiles (persist:halo-agent-*)
// and isolated children (halo-child-*) always keep their own.
const SHARED_POOL_PREFIX = "halo-task-";
function contextKey(policy, partition) {
    return policy === "shared" && partition.startsWith(SHARED_POOL_PREFIX) ? "shared-tasks" : partition;
}
// Under the shared policy one renderer serves every page of the same site inside one browser context.
// Pages in different contexts never share a process, so agent profiles and isolated children are unaffected.
function sharingFlags(policy) {
    return policy === "shared" ? { extraFlags: ["--process-per-site"] } : {};
}
class CdpEngine {
    config = {};
    connection = null;
    contexts = new Map();
    generation = 0;
    configure(settings) {
        const next = {
            browserEngine: settings?.browserEngine,
            chromiumPath: settings?.chromiumPath,
            chromiumEndpoint: settings?.chromiumEndpoint,
            chromiumContextPolicy: settings?.chromiumContextPolicy,
        };
        const changed = next.browserEngine !== this.config.browserEngine || next.chromiumPath !== this.config.chromiumPath || next.chromiumEndpoint !== this.config.chromiumEndpoint || next.chromiumContextPolicy !== this.config.chromiumContextPolicy;
        this.config = next;
        // New pages follow the new setting; pages already open finish on the browser they started on.
        if (changed)
            void this.release();
    }
    isActive() { return this.config.browserEngine === "chromium"; }
    connect() {
        if (!this.connection) {
            const { chromiumEndpoint, chromiumPath } = this.config;
            const attempt = (async () => {
                const browser = await hostModule.acquireCdpBrowser(chromiumEndpoint ? { endpoint: chromiumEndpoint } : { ...(chromiumPath ? { executablePath: chromiumPath } : {}), ...sharingFlags(this.config.chromiumContextPolicy) });
                const transport = await pageModule.connectCdpTransport(browser.wsUrl);
                return { transport, close: async () => { transport.close(); await browser.close(); } };
            })();
            // A failed start must not be cached forever: the next page retries.
            attempt.catch(() => { if (this.connection === attempt)
                this.connection = null; });
            this.connection = attempt;
        }
        return this.connection;
    }
    // Returns a WebContentsView-shaped page, or null when the Electron engine is selected.
    createPage(partition) {
        if (!this.isActive())
            return null;
        const generation = this.generation;
        const key = `${generation}:${contextKey(this.config.chromiumContextPolicy, partition)}`;
        const provider = async () => {
            const { transport } = await this.connect();
            return transport;
        };
        return pageModule.createCdpView(provider, {
            isolated: true,
            sharedContext: (transport) => {
                let context = this.contexts.get(key);
                if (!context) {
                    context = transport.send("Target.createBrowserContext").then((result) => String(result.browserContextId));
                    this.contexts.set(key, context);
                }
                return context;
            },
        });
    }
    async release() {
        const connection = this.connection;
        this.connection = null;
        this.contexts.clear();
        this.generation += 1;
        if (connection)
            await connection.then((entry) => entry.close()).catch(() => undefined);
    }
}
module.exports = { CdpEngine };
