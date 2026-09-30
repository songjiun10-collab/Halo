"use strict";

// Real connected-service read, no model inference and no credential copying.
// HALO_CODEX_MCP_REPOSITORIES=deepseek-ai/deepseek-harness node integration/codex-mcp-smoke.js \
//   https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
const { CodexMcpAdapter, parseRepositories } = require("../main/harness/providers/codex-mcp-adapter");

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("Pass an explicitly scoped GitHub file URL");
  const adapter = new CodexMcpAdapter({ repositories: parseRepositories(process.env.HALO_CODEX_MCP_REPOSITORIES || "") });
  try {
    const result = await adapter.readFile(url);
    if (!result) throw new Error("URL is outside HALO_CODEX_MCP_REPOSITORIES or unsupported");
    console.log(JSON.stringify({ passed: true, server: result.server, tool: result.tool,
      sourceUrl: result.sourceUrl, authority: result.authority, latencyMs: result.latencyMs,
      sourceBytes: result.sourceBytes, returnedBytes: Buffer.byteLength(result.text),
      truncated: result.truncated, range: result.range }));
  } finally { await adapter.close(); }
}

main().catch((error) => { console.error(JSON.stringify({ passed: false, code: error.code || "smoke_failed" })); process.exitCode = 1; });
