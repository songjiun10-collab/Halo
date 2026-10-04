# HALO / Browser Two-Repository Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create separate local `Halo-Core` and `Halo-Browser` repositories under `/Users/songjiun/Halo-workspace/` while preserving `/Users/songjiun/Halo` as the source and rollback checkout.

**Architecture:** Core owns policy, provenance, the production approver service, and its versioned Unix-socket protocol. Browser owns the Electron app and frontend at its repository root and talks to Core only through that protocol; production Browser code must not import Core internals or E007 experiment modules. This split is local-only.

**Tech Stack:** Git local clone/init, Python packaging and pytest, Node.js/Electron, TypeScript/Vite, Unix-domain sockets, length-prefixed JSON.

**Spec:** `docs/superpowers/specs/2026-10-01-halo-two-repository-split-design.md`

## Global Constraints

- Keep `/Users/songjiun/Halo` and every dirty/untracked file unchanged; do not stage, commit, reset, clean, or push there.
- Create exactly two local repositories under `/Users/songjiun/Halo-workspace/`; the parent is not a repository.
- Do not configure remotes in either new repository; do not create GitHub repositories, commits, or PRs.
- Preserve generated renderer assets byte-for-byte until their source hashes have been checked.
- Core is the sole approval authority; every unavailable, malformed, oversized, mismatched, or unsupported protocol result fails closed.
- Keep the repository split scoped to extraction and the local approval protocol. Codex/Orchard-inspired runtime work is a separate post-split design, not a reason to add scheduler, event API, or general RPC scope here.
- Protocol v1 uses `AF_UNIX`, a fresh `0700` private socket directory per service process, `uint32_be body_length` framing (header excluded from body size), `0 < body_length <= 65,536`, and one exchange per connection. It explicitly provides correlation, not replay prevention.
- Each Browser service process owns its own Core child/socket; it never reuses or probes endpoints from earlier runs. Core refuses any pre-existing bind path. Only the current process's own run directory is removed after Core exits; stale prior-run directories are left untouched.
- Core has at most 16 in-flight connections plus a kernel backlog of 16, no unbounded application queue, and a 4-second absolute exchange deadline. TaskHost supports up to eight parallel active tasks; tests must include those plus direct control actions. Overload returns `protocol.error/server_busy`, never an approval decision; clients do not retry approvals after readiness.
- Core stdin EOF initiates orderly shutdown; unexpected Core exit immediately disables approval-dependent dispatch. Version 1 has no automatic service restart or action replay.
- Production Browser code must not import `experiments.e007_dual_agent_provenance_gate`.
- Implementation starts only after the user reviews this plan and chooses an execution method.

## Review Focus

- Wrong Core Python environment: server startup must fail visibly and Browser must not dispatch.
- Stale decision for another request: request-ID mismatch must not authorize the current action.
- Truncated/oversized frame: neither endpoint may interpret partial data as a decision.
- Core restart during a decision: retries remain bounded and errors fail closed.
- Dirty/untracked renderer assets: copy/build must not silently lose or overwrite them.

## File Map

### Core repository

- `pyproject.toml` — installable `halo` runtime package and `halo-approver` entry point.
- `halo/approver_protocol.py` — production v1 socket framing, validation, and one-exchange transport.
- `halo/approver_server.py` — CLI and deterministic decision adapter using `halo.policy` and `halo.safety_cases`.
- `tests/test_approver_protocol.py` — frame, schema, filesystem, and socket lifecycle regressions.
- `tests/test_approver_server.py` — migrated policy/provenance assertions from `tests/test_computer_browser_approver.py`.

### Browser repository

- Root is the former `apps/computer-browser/` tree, including its package files and checked-in renderer output.
- `frontend/` and `design-system/` remain subdirectories at the Browser root.
- `package.json`, `frontend/vite.config.ts`, `main/index.js`, and path-sensitive integrations/tests are adjusted for the new layout.
- `main/approver-client.js` validates protocol version, response type, and matching request ID.
- Browser-local `approver/approver_service.py` is removed only after the Core entry point and tests pass.

### Workspace

- `README.md` — split ownership, independent setup/test commands, and combined local integration command.
- `MIGRATION-MANIFEST.md` — source ref/status, copied path list, dirty-file hashes, and verification results.
- `.gitignore` — ignores `.venv/`, local sockets, and temporary runtime logs.
- `.venv/` — optional ignored environment for editable Core install and integration tests.

## Tasks

### Task 1: Capture source state and approve the copy manifest

**Files:** Create `/Users/songjiun/Halo-workspace/MIGRATION-MANIFEST.md`; read-only access to `/Users/songjiun/Halo`.

**Interfaces:** Produces a recorded source commit, branch, full `git status --porcelain=v1 -uall`, tracked/untracked path inventory, Git index/tree mode and filesystem `lstat` mode/type, symlink targets, deletion state, and SHA-256 hashes for regular dirty Browser/frontend files and renderer assets.

- [ ] **Step 1: Capture baseline metadata**

Run from the source checkout: `git rev-parse HEAD`, `git branch --show-current`, `git status --porcelain=v1 -uall`, `git ls-files -s`, and a non-following filesystem inventory. Record outputs without staging or changing the source. For every source path, record Git mode where tracked, `lstat` type/mode, symlink target without following it, and status including deletions; hash file contents only for regular files.

- [ ] **Step 2: Record the extraction allowlist**

Core keeps HALO policy/research paths such as `halo/**`, `experiments/**`, `artifacts/**`, `rust/**`, reports, and generic HALO docs. Browser receives `apps/computer-browser/**` at its root, plus `frontend/**` and `design-system/**`. List browser-specific docs individually; ambiguous docs remain in Core and are copied only when justified. Preserve every original source path.

- [ ] **Step 3: Verify the manifest against current dirty state**

Compare every dirty or untracked source path against the allowlist and assign its destination. Stop on any unclassified path; do not silently omit it.

### Task 2: Create local repository copies without modifying the source

**Files:** Create `/Users/songjiun/Halo-workspace/Halo-Core/.git`, `/Users/songjiun/Halo-workspace/Halo-Browser/.git`, workspace `README.md`, and `.gitignore`.

**Interfaces:** Exactly two local repositories, no remotes, no parent `.git`; Core starts from captured source history, Browser starts from the reviewed current Browser snapshot.

- [ ] **Step 1: Create Core from a local clone**

Clone the captured source ref with independent Git objects into `Halo-Core/`, remove every remote from that clone, then remove Browser/frontend/design-system working-tree paths from the new Core checkout only. Overlay manifest-approved dirty Core changes including additions, modifications, symlinks, executable modes, and deletions; apply deletions only in the new clone and only when represented by an explicit manifest entry. Compare path type, link target, executable/mode bits, and regular-file hashes after overlay. Historical monorepo commits may still contain Browser paths; do not rewrite history.

- [ ] **Step 2: Create Browser from the reviewed snapshot**

Initialize a local Git repository in `Halo-Browser/`, copy `apps/computer-browser/**` to its root and copy `frontend/**` and `design-system/**` into matching subdirectories. Preserve generated assets as-is and do not make a commit.

- [ ] **Step 3: Check repository and source boundaries**

Confirm both `git remote -v` outputs are empty, the workspace root has no `.git`, and no change in the original branch/status differs from Task 1.

### Task 3: Package Core and define the approval protocol

**Files:** Create `Halo-Core/pyproject.toml`, `Halo-Core/halo/approver_protocol.py`, `Halo-Core/halo/approver_server.py`, `Halo-Core/tests/test_approver_protocol.py`, and `Halo-Core/tests/test_approver_server.py`.

**Interfaces:**
- CLI: `python -m halo.approver_server --socket PATH`; installed command: `halo-approver --socket PATH`.
- Approval request v1 exact fields: `protocol_version: 1`, `type: "approval.request"`, `request_id`, `action`, `origin`, `summary`, `self_provenance`, `source`, `target_scope`, `contains_secret`.
- Approval response v1 exact fields: `protocol_version: 1`, `type: "approval.decision"`, matching `request_id`, `decision`, `reasons`.
- Health probe v1 exact fields: `protocol_version: 1`, `type: "health.ping"`; response: `protocol_version: 1`, `type: "health.pong"`. It is non-authorizing and returns no approval decision.
- Protocol error exact fields: `protocol_version: 1`, `type: "protocol.error"`, `code`; `code` is one of `malformed_frame`, `invalid_message`, `unsupported_version`, `server_busy`. Error responses contain no request-derived text and are never interpreted as policy denials or approval decisions.
- Response pairing is strict: `approval.request` accepts only `approval.decision` with the same request ID; `health.ping` accepts only `health.pong`. Any other response type fails closed.
- Framing: exactly a 4-byte unsigned big-endian body length followed by that many JSON bytes; the header is excluded from the body limit and `0 < body_length <= 65,536`. Each sender half-closes its write side after one frame; the receiver reads to EOF to detect truncation/trailing bytes before responding. Distinguish EOF before any header byte, partial header, and partial body. Enforce a 4-second absolute server deadline for one full exchange and keep the Browser total request timeout at 5 seconds.
- Listener stays bound and serves one exchange per connection with at most 16 in-flight connections, `listen(backlog=16)`, and no unbounded application queue. When in-flight capacity is full, return `protocol.error/server_busy`; never issue a decision. Retry connections only during bounded startup readiness; never automatically retry an approval request after readiness.
- Each Browser service process creates a fresh `mkdtemp` 0700 runtime directory and never reuses an endpoint from an earlier run. Core refuses to bind if its expected socket path already exists and never unlinks a path it did not create. An unexpected path in the fresh directory fails closed without probe or cleanup; stale sockets in older run directories remain untouched and unused. On shutdown, Core removes only the exact socket inode it bound; after Core exits, Browser removes only its own run directory.
- Spawn Core with an explicit absolute `HALO_PYTHON`, isolated `-I`, private runtime cwd, and a piped stdin. Browser waits for a valid health exchange (1-second probe timeout within a bounded startup deadline) and confirms the child remains alive before enabling protected actions; stdin EOF requests orderly Core shutdown so Browser exit/crash does not leave an orphan. Unexpected Core exit clears readiness and blocks protected actions; v1 does not automatically restart Core or replay an action.
- The socket path must fit macOS `sockaddr_un.sun_path` (104 bytes including NUL); reject paths whose encoded byte length is 104 or more. `lstat` the runtime directory and socket, requiring current UID, mode 0700 for the directory, and no symlinks. These controls do not isolate against a compromised same-UID process; path-based `lstat` then `unlink` is not race-free against that actor.
- `request_id` is only a correlation identifier, not a replay-prevention token. v1 has no replay cache or exactly-once guarantee; repeated IDs on separate connections may be evaluated independently. Browser generates a fresh unpredictable ID for each request and checks that the response matches the currently outstanding request.
- Decisions accepted by Browser: `allow`, `review`, `deny`, `quarantine`; Core emits only outcomes supported by its existing deterministic policy.
- Production Core imports only `halo` modules; it does not import Browser or `experiments/`.

- [ ] **Step 1: Write decision-behavior regression tests**

Port the provenance, action mapping, malformed-field, and allow/review/deny cases from source `tests/test_computer_browser_approver.py` into Core tests. Keep existing semantics unchanged.

- [ ] **Step 2: Run the new tests to confirm they fail before implementation**

Run: `python -m pytest tests/test_approver_server.py -q` from `Halo-Core/`. Expected: missing module/entry point.

- [ ] **Step 3: Write v1 protocol tests**

Cover valid approval and health exchanges; exact field sets; wrong version/type; request-ID mismatch; duplicate `request_id` on separate connections (documented as correlation-only, no replay rejection); zero and 65,537-byte bodies; exactly 65,536-byte acceptance at the framing layer; EOF before header, partial header/body, invalid UTF-8/JSON, trailing bytes, sender half-close behavior, a 4-second absolute deadline including slow-drip/no-half-close clients, and verify the next client still succeeds; symlink path rejection, non-0700/wrong-owner parent rejection, 104-byte encoded path rejection, one approval exchange then close, and exact 4-byte big-endian framing.

- [ ] **Step 4: Implement package metadata, transport, and server**

Add the package entry point and move the existing deterministic mapping/evaluation behavior into `halo/approver_server.py`. Implement production framing in `halo/approver_protocol.py`; do not change policy semantics. Keep E007 available as an experiment, but remove it from production imports.

- [ ] **Step 5: Run Core-focused tests**

Run `python -m pytest tests/test_approver_protocol.py tests/test_approver_server.py -q` and `python -m pytest tests/test_policy.py tests/test_safety_cases.py -q` from `Halo-Core/`.

Expected: all pass, with no production import of `experiments.e007_dual_agent_provenance_gate`.

### Task 4: Make Browser build and runtime paths standalone

**Files:** Modify `Halo-Browser/package.json`, `Halo-Browser/frontend/vite.config.ts`, `Halo-Browser/main/index.js`, and path-sensitive files under `integration/` and `test/`.

**Interfaces:** Browser root is the former app directory; Vite output is `renderer/dist`; Browser app root, user project working directory, and Core runtime location remain distinct settings.

- [ ] **Step 1: Add path regression assertions**

Test app root, local frontend build, renderer entry, fixtures, and user project cwd independently, including invocation from outside the Browser repository.

- [ ] **Step 2: Run the focused path tests before edits**

Run from `Halo-Browser/`: `node --test test/runtime-command-gates.test.js test/main-entrypoint-lifecycle.test.js`. Expected: old monorepo assumptions fail.

- [ ] **Step 3: Update only confirmed path assumptions**

Make Browser `build` invoke local `frontend/`; set Vite `outDir` to `../renderer/dist`; remove `main/index.js`'s hardcoded monorepo root; update integration scripts that derive Core or app paths. Do not replace configured user project cwd with Browser root.

- [ ] **Step 4: Verify standalone Browser checks**

Run from `Halo-Browser/`: `npm run check:runtime`, `npm run typecheck`, `npm test`, and `npm run build`.

Expected: they do not read `/Users/songjiun/Halo` or sibling Core source files.

### Task 5: Connect Browser to Core protocol v1 and fail closed

**Files:** Modify Browser `main/approver-client.js`, `main/index.js`, `main/control-api.js`, and approval/lifecycle tests; remove `approver/approver_service.py` from Browser after Core passes Task 3.

**Interfaces:** Browser sends Task 3's exact request schema; it accepts a response only when protocol version/type and request ID match. It launches the configured Python with `-I -m halo.approver_server --socket PATH`, then waits for protocol health readiness before enabling protected actions.

- [ ] **Step 1: Add failing client/controller tests**

Test valid decisions; wrong response type (`health.pong` for approval or `approval.decision` for health); missing/mismatched request ID; duplicate IDs across connections per the correlation-only contract; each protocol error code; invalid, truncated, or oversized response; correct request half-close; connection refusal; bounded startup readiness with a 1-second probe timeout; and unexpected child exit. For every invalid or error case assert the protected action dispatch count is zero. Test process-scoped runtime behavior: (a) leave a stale socket in a previous run directory and assert new startup neither probes, reuses, nor unlinks it; (b) place any unexpected file/socket/symlink at the new run's expected path and assert fail-closed without unlink; (c) assert Core refuses pre-existing bind paths and only removes the same inode it created on clean shutdown; (d) assert Browser validates the 0700/current-UID directory before connecting; (e) assert Browser exit/closed stdin stops accepting, drains/aborts in-flight connections by their deadline, unlinks only Core's inode, exits, and only then removes that Browser process's own runtime directory; (f) assert a readiness timeout or child death immediately disables dispatch and does not auto-replay or auto-restart. Leave directories from abnormal prior exits untouched.

Also test the persistent listener with concurrent requests: no more than 16 handlers run concurrently; at configured `maxParallelTasks` (supported range 1-8), all active tasks plus the direct control API request pattern fit without `server_busy`; request 17 while saturated receives only `protocol.error/server_busy` and triggers zero protected dispatches; release capacity and verify the next request succeeds. Verify backlog overflow is a connection failure, never retried after readiness, and request/response IDs stay paired.

- [ ] **Step 2: Run approval-focused tests before implementation**

Run from `Halo-Browser/`: `node --test test/approver-client.test.js test/control-api.test.js test/main-entrypoint-lifecycle.test.js`. Expected: v1 conformance checks fail.

- [ ] **Step 3: Implement v1 client and service launch**

Validate the full response schema and response-type pairing before forwarding decisions; use an explicit absolute Python path and isolated `-I`; create/validate one private 0700 `mkdtemp` directory per Browser service process; require the expected socket path to be absent and fail without unlinking if it is not; validate `sun_path` byte length; use a 1-second-bounded `health.ping` probe within the startup deadline only to confirm the spawned child is ready; track child liveness; connect stdin EOF to orderly service shutdown; enforce max 16 in-flight exchanges with `server_busy` overload and compare against task/control-path concurrency; and clean up only the exact socket inode the child bound. Do not reuse or scavenge stale endpoints. Remove the local Python policy implementation only after the Core service is verified.

- [ ] **Step 4: Run approval-focused Browser tests**

Run the same command as Step 2. Expected: invalid/unavailable responses never dispatch the protected action.

### Task 6: Add workspace setup and real cross-repository integration

**Files:** Create workspace `README.md`, `.gitignore`, and `tests/test_approver_integration.py`; update Browser integration run instructions where they refer to the old root.

**Interfaces:** Workspace bootstrap installs Core editable in an ignored `.venv`; integration starts the Core CLI and uses Browser's production client over a temporary private Unix socket.

- [ ] **Step 1: Add the integration test first**

Exercise a real Core service exchange and matching request ID; also exercise Core unavailable and unsupported-version cases, asserting no action dispatch.

- [ ] **Step 2: Verify the integration test fails before bootstrap is documented**

Run `python -m pytest tests/test_approver_integration.py -q` from the workspace. Expected: missing workspace setup until Task 2/3/5 are wired.

- [ ] **Step 3: Document setup and independent commands**

Document Core editable installation, Browser dependency/build/test commands, and the combined integration test. Ignore only `.venv/`, local socket files, and temporary runtime logs.

- [ ] **Step 4: Run the actual cross-repository integration**

Run `python -m pytest tests/test_approver_integration.py -q`. Expected: valid correlated exchange succeeds; unavailable or invalid protocol never dispatches.

### Task 7: Final verification and handoff to security-runtime design

**Files:** Update workspace `MIGRATION-MANIFEST.md` and `README.md` with final evidence.

- [ ] **Step 1: Run Core, Browser, and workspace suites separately**

Record exact commands, counts, and environment/baseline failures; do not collapse independent test results into one green claim.

- [ ] **Step 2: Search Browser for forbidden imports and source paths**

Search `Halo-Browser/` for `experiments.e007_dual_agent_provenance_gate`, `../../frontend`, `apps/computer-browser`, and hard-coded `/Users/songjiun/Halo`. Remove accidental dependencies; document any legitimate fixture-only references.

- [ ] **Step 3: Verify source and remote state**

Confirm original branch/full status match Task 1; confirm no remotes in either new repository, no parent `.git`, and no migration-created commits.

- [ ] **Step 4: Prepare, but do not implement, the next security-runtime project**

After split acceptance, create a separate runtime-harness design/spec that decomposes the requested work into testable boundaries: (1) mandatory/user policy layers, allow/ask/deny Action Review, structured action log, and per-tool/domain/filesystem capabilities; (2) task/agent sandbox isolation, persistent lifecycle, subagent boundary, handoff/taint propagation, and browser session isolation; (3) local/cloud trust boundary and credential isolation; (4) evidence-gated goal completion, fresh-context read-only evaluation, operator stop/steer, and bounded long-run recovery; (5) audit/replay plus attack/recovery verification. Carry forward Codex's centralized typed approval, execution-context project trust, and attributable policy events; Orchard's explicit lifecycle reconciliation and capacity-aware worker admission; Symphony's clean scheduler/workspace/runner/observability layers, bounded concurrency and revalidation; Agents SDK's schema-validated handoff metadata with HALO-controlled redaction; and Anthropic's default-fail evidence loop and fresh-context evaluator. HALO must not inherit Symphony's lack of exact scheduler-state restoration or reliance on the agent framework/host for sandbox strength, and must not treat Anthropic's sample hooks, progress files, or evaluator verdicts as a security boundary. Evidence, stop/steer, policy, and resource limits must be enforced by the host and journal. These are design inputs, not code dependencies, and must be threat-modeled and adversarially tested for HALO/macOS before implementation. No feature subsystem is part of this migration.

## Handoff

Review this plan and select an execution method before any repository creation, copy, path edit, or code change. After the split meets its acceptance criteria, begin a separate security-runtime design/spec for the additional requested features.
