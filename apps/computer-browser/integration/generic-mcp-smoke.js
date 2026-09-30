"use strict";

// Explicit public-read acceptance probe, not a generic unattended approval mode.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { GenericMcpBroker } = require("../main/harness/generic-mcp-broker");
const { CodexMcpProvider } = require("../main/harness/providers/codex-mcp-provider");
const { validateMcpArguments } = require("../main/harness/mcp-schema-validator");
const { parseRepositories, githubFileRequest } = require("../main/harness/providers/codex-mcp-adapter");

async function main() {
  const repositories = new Set(parseRepositories(process.env.HALO_CODEX_MCP_REPOSITORIES || ""));
  const args = githubFileRequest(process.argv[2], repositories);
  if (!args) throw Error("Pass an explicitly scoped public GitHub file URL");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "halo-generic-mcp-"));
  await fs.chmod(directory, 0o700);
  const journalPath = path.join(directory, "journal.jsonl");
  const file = await fs.open(journalPath, "wx", 0o600);
  const provider = new CodexMcpProvider();
  const started = Date.now();
  const broker = new GenericMcpBroker({ providers: [provider],
    getContext: () => ({ taskId: "public-read-smoke", goalVersion: 1, policyRevision: 1 }),
    validateArguments: validateMcpArguments,
    requestApproval: async (request) => ({ kind: "human", allowed:
      request.connectionId === "codex:codex_apps" && request.toolName === "github.fetch_file" &&
      JSON.stringify(request.arguments) === JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))) }),
    journal: { async append(event) { await file.write(`${JSON.stringify(event)}\n`); await file.sync(); } },
  });
  try {
    const connections = await broker.listConnections();
    const tools = await broker.searchTools("github.fetch_file");
    const approval = await broker.proposeCall({ connectionId: "codex:codex_apps", toolName: "github.fetch_file", arguments: args });
    const result = await broker.dispatchApproved(approval.id);
    const events = (await fs.readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    console.log(JSON.stringify({ passed: result.outcome === "ok" && events.length === 2,
      provider: "codex", connectionCount: connections.length, matchingTools: tools.length,
      outcome: result.outcome, authority: result.authority, returnedTextBytes: Buffer.byteLength(result.text),
      journalEvents: events.map((event) => event.type), latencyMs: Date.now() - started,
      measuredTokens: null, note: "Public read only; no production queue, token-saving or all-provider claim." }));
  } finally {
    await broker.close(); await file.close();
    await fs.unlink(journalPath); await fs.rmdir(directory);
  }
}
main().catch((error) => { console.error(JSON.stringify({ passed: false, code: error.code || "smoke_failed" })); process.exitCode = 1; });
