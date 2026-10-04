# HALO / Browser Two-Repository Split — Design

**Status:** Draft for user review
**Date:** 2026-10-01
**Scope:** Local repository/workspace split only. No GitHub repository creation, remote changes, commits, or pushes are included.

## 1. Goal

Create a parent workspace containing two independently runnable repositories:

```text
/Users/songjiun/Halo-workspace/
├── Halo-Core/       # HALO policy, approval, provenance, experiments, research
└── Halo-Browser/    # Electron computer-use browser and its UI
```

The existing `/Users/songjiun/Halo` checkout remains untouched as the source and rollback copy throughout the split. The parent workspace is not itself a Git repository. No files are removed from the original checkout as part of this operation.

## 2. Repository ownership

### Halo-Core

Owns the existing HALO safety/research system, including:

- `halo/` policy, gateway, provenance, approval, and safety code;
- `experiments/`, including E007 research code;
- `artifacts/`, `rust/`, Python tests, and core research reports;
- core-only docs and the canonical approver protocol implementation.

Core publishes a stable, versioned local approver service interface for browser clients. Browser must not import Core's private Python modules or experiment modules directly.

### Halo-Browser

Owns the current `apps/computer-browser/` application, relocated to the repository root, plus:

- `frontend/` and browser UI/design assets needed to build the app;
- browser-specific tests, package metadata, and browser/harness documentation;
- a small client for the Core approver service protocol.

The browser repository has no dependency on Core source layout. It talks to Core through the versioned local IPC contract described below.

### Initial path mapping

```text
apps/computer-browser/**  -> Halo-Browser/**
frontend/**               -> Halo-Browser/frontend/**
design-system/**          -> Halo-Browser/design-system/**
```

Browser-specific specs and docs move to Halo-Browser only after an explicit manifest is reviewed in the execution plan. Shared HALO architecture, policy, and research reports remain in Halo-Core. Ambiguous docs are copied first; they are not deleted from the source checkout.

## 3. Core ↔ Browser boundary

The browser's current approver service imports `experiments.e007_dual_agent_provenance_gate.channel`, `halo.policy`, and `halo.safety_cases` directly. This is a monorepo coupling and must be removed before the split is considered runnable.

Halo-Core will own a production approver-server entry point and the public protocol implementation. Halo-Browser will launch/configure that service and speak only the public protocol. The E007 experiment remains available and may reuse the Core transport, but production code must not depend on an `experiments/` path.

### Local socket protocol v1

- Transport: `AF_UNIX` stream socket under a fresh, per-service-process `0700` runtime directory created with `mkdtemp`. The directory and socket paths are checked with `lstat`; reject symlinks, wrong owner/mode/type, and socket paths that exceed macOS `sockaddr_un.sun_path` capacity (104 bytes including the NUL terminator). Each service process owns its own Core child and socket; a UI process detaching from a separate background-service process does not stop or share that service's approver.
- Framing: a 4-byte unsigned big-endian `body_length` header, followed by exactly `body_length` UTF-8 JSON bytes. The header is not included in the body limit. Require `0 < body_length <= 65,536`; reject zero, oversized, truncated, or trailing frame data. Each sender half-closes its write side after its single frame; the receiver reads through EOF before accepting the frame, then may send its response on the still-open reverse direction. Enforce an absolute 4-second server-side deadline for the complete frame/decision/response exchange; the Browser's total request timeout is 5 seconds. Distinguish EOF before any header byte from partial-header EOF and body EOF.
- Every request and response has an explicit `protocol_version: 1` field and a message `type`; exact v1 fields are defined in the implementation plan's protocol contract and shared conformance fixtures.
- The listener remains bound for the Core process lifetime and handles one exchange per connection. It uses at most 16 in-flight connections and a kernel listen backlog of 16; it must not create an unbounded application queue. This exceeds the current TaskHost-supported maximum of eight active tasks and leaves bounded room for direct control actions. If capacity is exhausted, return `protocol.error` with `code: "server_busy"` and issue no decision; OS-level backlog overflow is a connection failure. Browser may retry only during bounded startup readiness, never automatically retry an approval request after readiness.
- Response types are paired strictly: `approval.request` only accepts `approval.decision` with the matching `request_id`; `health.ping` only accepts `health.pong`. A `protocol.error` is never an approval decision. Malformed, unsupported, busy, or mismatched exchanges fail closed.
- `request_id` is a correlation identifier only, not a replay-prevention token. Protocol v1 has no replay cache or exactly-once guarantee. Browser must generate a fresh, unpredictable ID for every approval request and accept a response only for the currently outstanding ID; duplicate requests may be evaluated again. Any future replay/idempotency guarantee requires a separately specified protocol version and durable semantics.
- Startup health is distinct from socket-file existence. Each service process creates a fresh runtime directory and never reuses or probes an endpoint from an earlier run. Core must refuse to bind any pre-existing path and must never unlink a path it did not create. If the expected socket path unexpectedly exists in the fresh directory, startup fails closed without probing or deleting it. After launching Core, Browser waits for a bounded `health.ping` / `health.pong` readiness exchange and confirms the spawned child is still alive before enabling protected actions. On clean shutdown, Core removes only the socket inode it bound; Browser waits for Core to exit, then removes only its own run directory. A stale socket left by an abnormal exit remains in that old directory, is left untouched, and is never reused. If Core exits unexpectedly, Browser immediately marks it not-ready and blocks protected actions; v1 does not automatically restart it or replay an in-flight action. Browser closes the child's stdin pipe during shutdown; Core treats stdin EOF as a shutdown signal, stops accepting new connections, lets in-flight exchanges finish or time out within their deadlines, removes only its own socket inode, then exits.
- Unsupported versions, malformed JSON, oversized/truncated frames, identity mismatch, or service failure fail closed; the browser must not dispatch the protected operation. Runtime-directory permissions protect against other UIDs; a compromised same-UID process is outside this boundary. `lstat` followed by path-based `unlink` still has a same-UID race and must not be described as protection from same-user attackers. Overload is observable `server_busy`, not policy `deny` and never an automatic action retry.
- The public protocol is limited to approval/provenance decisions plus the non-authorizing health handshake. It does not expose arbitrary Python calls or a general RPC mechanism.
- Core and Browser keep shared protocol fixtures and conformance tests. Compatibility changes require a protocol version change or an explicitly backward-compatible additive field.

The exact request/response fields must be extracted from the current `approver_service.py` behavior during planning, recorded in a versioned schema, and tested byte-for-byte at the transport boundary before implementation is declared complete.

## 4. Python runtime and developer workflow

Core needs an installable Python package/service entry point because the current repository has no root `pyproject.toml`, `setup.py`, or `setup.cfg`. The split adds a minimal supported package definition for the public `halo` modules and approver server, without packaging research artifacts as runtime dependencies.

For a local source checkout, the parent workspace may provide one ignored `.venv/`. Core is installed editable into it; Browser starts the Core CLI using an explicit `HALO_PYTHON` setting or the documented workspace default. Each repository remains independently testable, while the two-repository integration test uses this workspace bootstrap. Runtime packaging/signing is not part of this local split.

## 5. Git history and safety

- Preserve the original checkout and its dirty/untracked files exactly; record its initial `git status` and compare after the operation. The migration manifest records each path's Git index/tree mode and filesystem `lstat` mode, file type, symlink target where applicable, content hash for regular files, and state (`added`, `modified`, `deleted`, or unchanged). A hash alone is not sufficient to prove an exact working-tree copy.
- Do not stage, commit, reset, clean, or push changes in `/Users/songjiun/Halo`.
- New repositories are local only and have no push-capable remote configured by this task.
- `Halo-Core` may begin from a local clone of the current repository history, then receive the reviewed core working-tree path set. This keeps existing history without rewriting the source history; older commits may still contain browser paths.
- `Halo-Browser` begins from the reviewed current browser source snapshot. Its prior file history is not rewritten or claimed as preserved. If full path-filtered history is desired later, it is a separate reviewed migration because it changes repository history and tooling requirements.
- Copy only from the exact source checkout and a reviewed path manifest. Never use a broad parent-directory move or destructive cleanup.

## 6. Migration sequence and acceptance criteria

No migration starts until this design is approved and the resulting implementation plan is reviewed.

1. Capture source branch, `git status`, tracked/untracked path inventory, and relevant baseline tests.
2. Create the parent workspace and local-only Core/Browser repository copies using a reviewed allowlist/denylist manifest.
3. Implement the Core package entry point and protocol; make E007 reuse or remain compatible without making production depend on experiment code.
4. Relocate Browser application/frontend paths and update package scripts, Vite output, Electron resource paths, docs, and tests.
5. Add workspace bootstrap and protocol conformance/integration tests.
6. Run Core-focused tests, Browser typecheck/unit/build tests, then the cross-repository local-socket integration test.
7. Verify each repository has the intended files, no unintended secrets/artifacts, no push remote, and cleanly documented run/test commands. Verify the original checkout's branch and full status are unchanged.

The split is accepted only if:

- the browser builds and its UI tests run from `Halo-Browser` without reading sibling Core source files;
- protected approval behavior is provided by the Core service over protocol v1, and malformed/unavailable service cases fail closed;
- Core's policy/provenance tests still pass, including E007 tests;
- Core and Browser test suites pass at their documented scopes, with any baseline or environment failures identified rather than hidden;
- the original `/Users/songjiun/Halo` checkout is unchanged;
- no GitHub or other remote repository state has been modified.

## 7. Out of scope

- Creating GitHub repositories, changing remotes, committing, pushing, or opening PRs.
- Deleting or restructuring the original monorepo checkout.
- Full history rewriting/path-filtering for the Browser repository.
- Designing a network protocol, remote/cloud approver, or general-purpose RPC layer.
- New product features unrelated to decoupling the two repositories.
- Production distribution, signing/notarization, installer, or automatic updater work.

## 8. Main risks

- **Policy drift:** duplicated or reimplemented approval logic in Browser would undermine the security boundary. Mitigation: Core is the sole decision authority; Browser only consumes explicit decisions.
- **Fail-open integration:** a missing or incompatible service could accidentally allow execution. Mitigation: strict protocol validation and tests proving no dispatch on any protocol/service error.
- **Path assumptions:** Electron, Vite, packaging, or tests may assume monorepo-relative paths. Mitigation: search for those assumptions and run the app/build from the new repository root.
- **Dirty source ambiguity:** existing modifications may have mixed ownership. Mitigation: inventory every changed/untracked path and review the copy manifest before copying; preserve all source files regardless.
- **History expectations:** Core retains monorepo history and Browser starts with a source snapshot. This is intentional for a safe local split, but does not provide a clean path-filtered history for both projects.

## 9. External architecture references: OpenAI and Anthropic

These repositories are reference material, not implementation dependencies. Do not copy their code into the split as part of this migration. The repository split remains limited to Core/Browser extraction and the local approval protocol; the runtime features below belong to the separate post-split design.

### OpenAI Codex: policy and execution boundaries

The Codex repository has useful, concrete patterns for a later HALO runtime design:

- **Centralize approval routing.** Codex models tool, patch, network, and permission requests as typed approval actions and routes them through a central approval stage. HALO should similarly use one policy/approval decision point rather than letting Browser, providers, or individual tools make their own allow decisions. HALO's independent Core approver remains authoritative; user-facing review is an input to that authority, not a replacement for mandatory policy.
- **Resolve project trust from the execution context.** Codex's project-trust lookup gives the active working directory precedence over repository-root settings and uses normalized path spellings. HALO should bind policy evaluation to the actual task cwd and canonical resource identity, not a model-provided project label or a broad global trust bit. Symlink and path-race behavior still requires HALO-specific adversarial tests.
- **Keep policy decisions structured and attributable.** Codex has a separate network-policy decision audit event with constrained fields for scope, decision, source, reason, protocol, host, and execution identity. HALO's action log should adopt a similarly typed decision record with stable task/agent/action IDs, policy source, decision (`allow`/`ask`/`deny`), reason codes, capability/resource scope, timestamp, and execution outcome. Secrets and raw credential values must not enter the audit record.
- **Treat sandboxing and approval as distinct controls.** An approval is not a sandbox, and a sandbox does not establish that an action was authorized. HALO should evaluate authorization before dispatch and enforce resource containment independently at the executor boundary.

Sources: [Codex approval routing](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/approvals.rs), [project trust lookup](https://github.com/openai/codex/blob/main/codex-rs/config/src/project_trust.rs), [network policy audit](https://github.com/openai/codex/blob/main/codex-rs/exec-server/src/client/network_policy_audit.rs), [filesystem sandbox implementation](https://github.com/openai/codex/blob/main/codex-rs/exec-server/src/fs_sandbox.rs), and [network approval handling](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/network_approval.rs).

### OpenAI Orchard: durable orchestration and worker isolation

Orchard is an Apple-Silicon VM cluster orchestrator, not an AI-agent harness. Its relevant contribution is operational orchestration, not model planning or approval semantics:

- **Separate desired work from worker lifecycle.** Orchard represents workers/VMs as resources with explicit status and reconciles local desired state against remote state through a finite-state transition table. HALO's long-running task runtime should likewise model task/agent lifecycle as explicit, persisted states and make restart/reconciliation behavior testable instead of relying on an in-memory loop.
- **Give each worker a bounded execution environment.** Orchard schedules VM workloads onto workers with declared resource capacity and checks that placement will not overcommit a worker. HALO can apply this to per-task/per-agent execution environments: each child receives a distinct browser session and sandbox identity, declared CPU/memory/tool capabilities, and a scheduler lease; a shared tab or mutable session must never be concurrently owned by multiple agents.
- **Use durable event history as an operational interface.** Orchard's store supports append/list/page/delete event operations and watch APIs. HALO should build audit/replay and UI timeline consumers over an append-only, cursor-paginated journal, with retention/compaction rules explicit and referenced evidence either retained or marked unavailable. The UI timeline must not become a second authority for decisions.
- **Make resource admission and observability first-class.** Orchard exposes worker capacity, online/offline health, scheduling duration, and resource-status metrics. HALO's 1-GiB memory budget and per-agent concurrency should be enforced by host-side admission control using measured process-tree RSS, not merely an advisory agent setting.
- **Keep privileged host functionality narrow.** Orchard's macOS local-network workaround isolates the privileged helper instead of running the full worker as root. The analogous HALO rule is to keep any host-level credential, network, or process broker small and capability-scoped; do not elevate the browser or model runtime wholesale.

These are design analogies, not proof that VM-level separation alone contains a compromised agent. HALO still needs macOS-specific threat analysis and real attack tests for shared-kernel, same-user, browser-profile, IPC, and credential boundaries.

Sources: [Orchard repository and macOS worker privilege guidance](https://github.com/openai/orchard/blob/main/README.md), [scheduler capacity/reconciliation](https://github.com/openai/orchard/blob/main/internal/controller/scheduler/scheduler.go), [worker lifecycle state machine](https://github.com/openai/orchard/blob/main/internal/worker/fsm.go), [durable event store](https://github.com/openai/orchard/blob/main/internal/controller/store/store.go), [event append and pagination](https://github.com/openai/orchard/blob/main/internal/controller/store/badger/badger_events.go), [resource capacity primitives](https://github.com/openai/orchard/blob/main/pkg/resource/v1/resources.go), and [worker resource/capability model](https://github.com/openai/orchard/blob/main/pkg/resource/v1/worker.go).

### OpenAI Symphony and Agents SDK: long-running runs and delegation

OpenAI's official [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) describes a layered scheduler/runner: repo-owned workflow contract, typed configuration, coordination, isolated per-work-item workspace, agent subprocess, tracker adapter, and observability. HALO should borrow the clean layer boundaries, bounded concurrency, revalidation/reconciliation before dispatch, retry backoff, and explicit workflow handoff states. Its Elixir implementation also separates an orchestrator authority from supervised agent tasks and records session/runtime metadata. Symphony explicitly does **not** prescribe strong sandboxing and says exact in-memory scheduler state is not restored; HALO must retain its stronger host-owned journal and recovery invariants rather than copy that limitation.

OpenAI's [Agents SDK handoff contract](https://github.com/openai/openai-agents-python/blob/main/docs/handoffs.md) makes transfer metadata schema-validated and supports filtering what the receiving agent sees. HALO should use an explicit, host-stamped handoff envelope (`parentTaskId`, `childTaskId`, goal/version, delegated capability IDs, taint/evidence refs, and a bounded reason), persist it before dispatch, and independently re-check policy at the child boundary. SDK-style history filtering is not a security boundary by itself: summaries may still contain tool arguments/results, so HALO must redact before constructing child context and treat all inherited evidence as tainted until validated.

Symphony also documents token accounting and structured lifecycle logging. HALO should distinguish cumulative usage from deltas and tie metrics to durable task/turn IDs, while keeping observability records separate from authorization state.

Sources: [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md), [Symphony orchestrator](https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/orchestrator.ex), [runtime supervisor](https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/agent_runtime_supervisor.ex), [isolated workspace manager](https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/workspace.ex), [token accounting](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md), and [Agents SDK handoffs](https://github.com/openai/openai-agents-python/blob/main/docs/handoffs.md).

### Anthropic long-running harness and Agent SDK: evidence-gated progress

Anthropic's [long-running harness example](https://github.com/anthropics/cwc-long-running-agents) contributes a useful completion-quality loop: criteria default to failing, the builder must inspect evidence before claiming completion, and a separate fresh-context evaluator reviews the diff and evidence without write tools. It also demonstrates an operator kill switch, one-shot steering, and structured progress handoff between sessions. HALO should adapt these as host-enforced states: criteria and evidence references live in the durable journal; only a host-side verifier can advance a criterion; the evaluator has read-only capabilities and cannot approve or execute; and stop/steer controls synchronously close action admission before dispatch can continue.

Important limitations in that repository are explicitly documented by Anthropic: its hook is a teaching example, weak file matching and alternate write paths can bypass it, and the evaluator's Bash access is not a hard read-only boundary. HALO must not treat prompt instructions, local result-file conventions, Git commits, or application hooks as security enforcement. Enforce policy and evidence gates in the privileged host/controller, and use isolated evaluator capabilities at the OS/runtime layer.

The [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python) separates tool availability from permission: `allowed_tools` can auto-approve tools rather than remove them, while `disallowed_tools` is the block list and unlisted tools still pass through permission handling. HALO should keep these concepts separate in its own API (`available tools`, `capability grants`, `approval decision`) and never equate a visible/registered tool with authorization. SDK hooks are useful integration points, but HALO's mandatory policy remains outside and above provider-specific permission modes.

Sources: [Anthropic harness README and quality loop](https://github.com/anthropics/cwc-long-running-agents/blob/main/README.md), [default-fail evidence gate](https://github.com/anthropics/cwc-long-running-agents/blob/main/claude-code-config/.claude/hooks/verify-gate.sh), [fresh-context evaluator](https://github.com/anthropics/cwc-long-running-agents/blob/main/claude-code-config/.claude/agents/evaluator.md), [kill switch](https://github.com/anthropics/cwc-long-running-agents/blob/main/claude-code-config/.claude/hooks/kill-switch.sh), [steer hook](https://github.com/anthropics/cwc-long-running-agents/blob/main/claude-code-config/.claude/hooks/steer.sh), and [Claude Agent SDK tool permissions](https://github.com/anthropics/claude-agent-sdk-python#using-tools).

### HALO-specific decisions retained

- Keep immutable host-owned goals, durable journal/recovery, provenance/taint, stale-approval invalidation, and execution-uncertain semantics; neither reference replaces these controls.
- Core remains the sole policy decision authority across the repository boundary. Browser may gather evidence and present review UI, but cannot turn unavailable Core, invalid protocol, or missing evidence into `allow`.
- A long-running harness must couple goal progress to independently checked evidence, fresh-context review, explicit handoff state, measured resource admission, and operator stop/steer controls. These controls must be host-enforced; agent-authored progress and evaluator text are evidence inputs, not authority.
- After the split is accepted, draft a separate runtime-harness design that combines these reference patterns with HALO's existing invariants. Do not grow the split protocol into a general RPC, worker scheduler, or remote-control plane.
