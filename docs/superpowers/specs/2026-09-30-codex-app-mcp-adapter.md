# Codex app MCP adapter v1

## Decision (2026-09-30)

Use Codex's supported app-server JSON-RPC interface, not a copy of connector
tokens or a reverse-engineered desktop endpoint. The installed CLI schema
contains `app/installed`, `mcpServerStatus/list`, and `mcpServer/tool/call`.
A read-only live probe initialized app-server and found the `codex_apps`
server and installed, callable connectors. This corrects the earlier claim
that no supported direct tool-call interface exists. Individual tool calls
still require end-to-end verification.

Reference: https://learn.chatgpt.com/docs/app-server

## Boundary and first usable slice

HALO host -> bounded app-server stdio client -> owned ephemeral runtime thread
-> exact allowlisted connector tool -> compact untrusted browser observation.
No model turn is started in Codex. Claude remains a proposal-only planner;
its fixed CLI model is `opus`, and its existing tool/customization disabling
flags remain in force. Provider-local authentication stays inside each CLI.

The first browser integration reads GitHub file pages in explicitly enabled
repositories through the connected GitHub `fetch_file` tool. A host launch
setting, `HALO_CODEX_MCP_REPOSITORIES=owner/repo,owner/other`, is the authority.
An empty setting disables the integration. It is not inferred from a page,
model response, imported settings, or tool annotation. Only exact HTTPS
github.com file URLs without credentials, query, custom port, or ambiguous
encoded separators are routed. Unsupported pages use the DOM path.

The browser keeps its own observation ID, URL, document epoch and element
handles. The returned file text replaces only the free-text channel and is
marked `untrusted_connector`. Before returning, recheck the browser epoch
and URL; a navigation racing the MCP call discards that result. The adapter
never turns a tool response into evidence of goal completion. All browser
actions continue through existing policy, approval and durable dispatch.

## Transport and lifecycle

- One lazily started app-server process per HALO runtime, not per agent.
- An ephemeral owned thread provides the MCP runtime. No user conversation
  is resumed or mutated; no `turn/start`, arbitrary shell, config write,
  resource fetch, URL fetch or MCP server registration is exposed.
- Sequential calls, finite queue/in-flight limits, bounded JSONL input,
  output and request timeout. Timeout/abort invalidates the connection;
  uncertain requests are never automatically replayed.
- Unexpected server permission/elicitation requests are declined. Raw
  credentials, stderr and connector payloads are not written to logs.
- Register the process with HALO's process-tree memory monitor. Close it
  with the host, escalate a stuck exit after a bounded grace interval.
- Inventory is host-only: match exact tool identity and app ownership.
  Check installed enabled/callable state and runtime inventory before each
  call. Do not inject hundreds of tool schemas into the planner context.

## Response and performance contract

Text-only results, capped at 4 KiB UTF-8, with truncation, source, tool name,
latency and byte counters. An explicit connector error, invalid response,
unsupported capability, unavailable login, busy broker or memory pressure
uses the ordinary browser observation. Cancellation/disposal must not leak
late connector text into another task. No shared result cache in v1; no
cross-account or stale-cache inference.

Choose the MCP observation only when its full serialized byte count is
smaller than the current DOM observation. Otherwise keep DOM and record
`not_smaller`. Preserve at most 12 in-repository links with stable element
IDs; reset dangling parent IDs to null. Query deadlines bound the entire
observation, including startup, discovery and tool execution.

Thread overrides disable unnecessary configured local MCP servers before
the owned connector runtime starts. Use flat dotted config keys such as
`mcp_servers.node_repl.enabled=false`: assigning an empty parent table does
not clear layered configuration. These are session overrides, not global
configuration writes or managed-policy bypasses.

Byte reduction is not token reduction. A local fixture can verify context
byte bounds; real token and wall-time gains need same-task/model/effort
measurements including connector latency. Large source files may truncate
useful content and need later pagination/ranged retrieval.

## Verification

Test secret-env exclusion, fixed Opus argv, request correlation, malformed/
oversized frames, timeouts, server-request denial, concurrency, shutdown,
exact tool/app matching, disabled app rejection, forbidden URLs/repositories,
tool errors, UTF-8 limits, navigation races and browser fallback. Exercise
the real local Codex binary and an explicitly scoped public GitHub file;
report this separately from stubbed tests and Claude authentication.

## Local verification record — 2026-09-30

Codex and the existing Claude Desktop Code session (Opus 5.5) split transport/
host integration and adapter/observation work respectively. After the host
lifecycle test fixtures were updated, the browser package's full `node --test`
run initially passed 1,087 tests. After deadline/reaping review and an enabled-
MCP host lifecycle regression, Codex independently reran the final browser
suite: 1,093 tests passed, with zero failures, cancellations or skips.
Regressions cover hung startup/config, slow teardown, rejected teardown
(permanent fail-closed admission), and immediate cancellation on adapter close.

A real Electron + connected GitHub read used the scoped public URL
`https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md`.
With unrelated local MCPs disabled only in the owned thread:

| Measurement | Single-run result |
| --- | ---: |
| DOM observation JSON | 2,687 bytes |
| Candidate connector observation JSON | 3,407 bytes |
| Selected observation JSON | 2,687 bytes (DOM) |
| Fallback reason | `not_smaller` |
| Observation byte reduction | 0% |
| Observation latency | 1,716 ms |
| Codex process-tree sampled peak RSS | 348,307,456 bytes |
| Disposable Electron smoke process-tree sampled peak RSS | 840,450,048 bytes |

An earlier untrimmed run sampled 965,541,888 bytes for the Codex process tree
and 1,452,670,976 bytes for the smoke process tree. These are individual
100-ms-sampled runs, not a paired benchmark, hard memory bound or full
interactive-app measurement. No model inference or token count was measured.
This README demonstrates the no-growth selection guard, not token savings.

## Remaining scope (v1)

Writes, arbitrary MCP discovery in the model, other services, cross-host
sessions and a Codex planner are not part of v1. Add services as reviewed
host-owned mappings with separate argument/scope validation. This does not
make third-party MCP implementations inherently trustworthy, and local
Codex configuration remains part of the trusted computing base.
