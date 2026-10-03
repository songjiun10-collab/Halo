# Per-Agent Docker Runtime Design

**Date:** 2026-10-03  
**Status:** Selective per-child runtime contract; supersedes the all-children Docker wording in the 2026-09-28 multi-agent draft  
**Platform:** macOS host with local Docker Desktop; no remote Docker daemon

## Goal

Let the parent agent select Docker isolation per child assignment. Ordinary
children keep the current host runtime and parent browser session. Only a child
explicitly marked `execution: "docker"` receives a disposable container,
child-only workspace, planner worker, and browser storage partition. Keep
HALO's parent coordinator, journals, approval queue, policy checks, and
evidence verification on the trusted host. A container is an isolation
boundary for one selected child; it is not itself an authority to perform
browser actions or approve work.

## Existing boundary

`ChildAgentCoordinator._attachChild()` currently constructs a host-side browser
adapter and planner for each child, and passes the planner directly to a
`TaskController`. Child controllers are observe/scroll-only, have separate
journals and views, and cannot approve or create grandchildren. Child views
currently share the parent's session partition. This provides view separation,
not cookie or storage isolation.

The approved `2026-10-01-local-mcp-docker-sandbox-design.md` describes Docker
containers for allowlisted local MCP servers. That subsystem is separate from
agent containers: an MCP server container is not an agent sandbox and must not
be repurposed as one.

## Trust boundary and ownership

```text
HALO host (trusted policy and lifecycle owner)
  Parent TaskController / durable journals / approval queue / ResourceAdmission
       │ bounded, authenticated planner RPC
       ▼
  child execution: host (default) OR one container (parent-selected)
       │ typed browser proposal RPC only
       ▼
  host BrowserActionGateway (container mode)
       │ existing child observe/scroll policy + origin/epoch checks
       ▼
  child-owned Electron browser surface + child-only storage partition
```

- The host alone validates assignments, creates child IDs, derives the image
  and command from a host catalog, binds RPC identity to child ID and parent
  goal version, writes journals, checks evidence, and tears down resources.
- The child container never receives Docker socket access, host filesystem
  mounts, the parent journal, another child's workspace, host credentials,
  browser cookies, or approval authority.
- The container can request a browser observation or propose an action only
  through the authenticated host RPC. The host revalidates every request and
  enforces the child's existing observe/scroll-only policy. No direct CDP,
  DevTools port, arbitrary IPC channel, or raw browser command is exposed.
- Child output, logs, files, planner messages, and claimed evidence are
  untrusted. The parent continues its existing independent verification.

## Parent selection contract

- `child_plan.assignments[]` may carry an optional
  `execution: "host" | "docker"` field. Omission is normalized to `"host"`;
  old durable plans without the field recover as host execution.
- The parent planner selects `"docker"` only for the specific child whose
  assignment needs the stronger process/filesystem boundary. It does not set a
  parent-wide mode, and selecting Docker for one sibling does not change any
  other assignment.
- The host advertises only execution modes actually available on that run.
  An unsupported Docker selection is rejected before child stores, processes,
  browser surfaces, or leases are created. It must never silently downgrade
  to host execution.
- Host execution preserves the existing parent session partition. Docker
  execution gets a separate child-only in-memory partition and no copied
  cookies. This currently means authenticated sites may appear logged out in
  an isolated child; no credential inheritance is implied.
- The current app advertises `executionModes: ["host"]`. The assignment schema
  accepts a Docker request so it can be durably specified once the runtime is
  implemented, but current `ChildAgentCoordinator` rejects that request with
  `isolation_unavailable` before creating child storage.

## Planner process placement

Moving a Docker boundary around `_attachChild()` without moving the planner
worker is not per-agent isolation. The implementation must make the planner
worker a container-owned process and connect it to `TaskController` through a
host-owned, bounded JSONL transport. Existing provider adapters may run inside
the image only when their launch contract is explicitly supported.

Provider credentials must not be copied from `~/.claude`, `~/.codex`, app
settings, or browser profiles into an image or bind mount. A provider may be
enabled in the container only through a separately designed host broker that
does not reveal long-lived credentials to the planner process. Until that
broker exists for a provider, that provider is unavailable for containerized
children; the host must return a typed `provider_unavailable` result rather
than falling back to a host-side child planner.

The planner RPC is one request in flight per child, has bounded frame/context
sizes and a deadline, binds every message to the child ID and current goal
version, and never retries an ambiguous dispatched browser action. Malformed,
oversized, replayed, or mismatched frames fail closed and retire the worker.

## Browser storage isolation

- A host-executed child uses the parent's existing session partition, as in
  the current multi-agent runtime.
- A Docker-selected child receives a host-generated in-memory Electron
  partition derived from a collision-resistant child identity. Parent and
  sibling partitions are distinct. Renderer input, the planner, and the child
  assignment cannot choose or override the partition.
- No parent cookies, local storage, service workers, downloads, or cache are
  copied into a child partition by default. Authenticated work requires an
  explicit future credential-broker design; it must not silently fall back to
  the parent's logged-in session.
- A child owns one BrowserAdapter and one browser view for its lifetime. It
  cannot attach to another child's view or take the visible user's tab.
- Teardown clears the partition and removes the child workspace after durable
  terminal state is recorded. If removal cannot be confirmed, keep the lease
  and report cleanup pending; do not admit replacement work on the assumption
  that the old resources disappeared.

## Container catalog and launch

- Containers are enabled only by an explicit host setting and an immutable
  host-only catalog entry. Entries pin an OCI image by `sha256` digest and a
  fixed command/arguments schema. No agent, goal, renderer, or page content can
  select an image, executable, mount, Docker flag, or environment variable.
- Start with `--pull=never`; absent images return `needs_image`. Do not auto
  pull or substitute a tag/digest.
- Use only a verified local Docker Desktop endpoint. Remote contexts, unknown
  endpoints, endpoint-check failures, and caller-provided daemon overrides are
  rejected. Never mount the Docker socket in the child.
- Required baseline: `--rm -i --read-only --cap-drop ALL
  --security-opt no-new-privileges --user 65534 --pids-limit 128 --memory 256m
  --memory-swap 256m --cpus 1 --tmpfs /tmp:size=16m`. Add only host-generated,
  child-scoped mounts; default root filesystem remains read-only.
- Pass an explicit minimal environment. Do not inherit shell, Docker, provider,
  proxy, or HALO secret environment variables.
- Apply HALO-owned labels for app, user-data-root digest, runtime-owner ID,
  parent task ID digest, and child ID. Cleanup may signal only containers whose
  full label tuple and owner identity match this runtime. Unknown ownership
  means manual cleanup, never broad deletion.

## Network policy

Docker bridge egress is not a domain allowlist. `--network=none` is the default
for child images that do not need model access. A networked planner is enabled
only after an egress broker is implemented and tested: the container can reach
that broker, while direct egress and arbitrary host access are blocked. A
generic `egress` setting must be named as unrestricted egress and cannot be
presented as domain filtering. Provider endpoints and any browser traffic are
separate grants; browser navigation remains mediated by the host adapter.

## Resource admission and lifecycle

- Before creating any container, browser partition/view, planner transport, or
  workspace, acquire one serialized `ResourceAdmission` lease for the child.
  Use measured high-water data where available and a conservative fixed
  container reservation otherwise. Unknown or stale accounting queues the
  child in budgeted mode.
- The user override does not remove per-container CPU, memory, PID, or file
  limits and does not authorize weakening launch flags.
- Record host-generated container ID, child identity, image digest, admission
  decision, browser partition identity, and lifecycle transitions in the
  child journal. Never record provider secrets, RPC bearer material, or full
  environment values.
- Shutdown order: stop accepting planner RPC; drain or cancel the controller;
  durably record terminal/uncertain state; terminate and confirm the container;
  close the planner channel; destroy the browser view and clear its partition;
  remove workspace; release the admission lease last.
- If a browser action may have dispatched before a crash, preserve
  `execution_uncertain`; recovery never replays it. A recovered child is not
  restarted automatically. Explicit user resume may create a fresh isolated
  runtime only after the prior container and partition are confirmed gone.
- UI detach does not terminate the background runtime owner. Only that owner
  may reconcile stale containers, and only after private owner identity and
  exact labels are verified.

## Rollout phases

1. **Host boundary:** define and test planner RPC, provider capability states,
   per-child storage partition, labels, cleanup ownership, and resource leases.
   Keep current host planner path behind an explicit legacy setting; never
   silently fall back when Docker is requested.
2. **Offline container pilot:** run a synthetic child worker with
   `--network=none`, no secrets, no host mounts, fake browser transport, and
   fake model output. Verify sibling isolation and crash cleanup.
3. **Provider broker:** add one provider at a time through a host credential
   broker and tested egress proxy. Do not mount local CLI auth directories.
4. **Browser profile isolation:** enable child partitions with no inherited
   login. Design scoped credential access separately before authenticated
   browsing.
5. **Measured opt-in:** benchmark macOS Docker Desktop VM overhead, planner
   RSS, browser renderer RSS, startup latency, crash recovery, and concurrent
   children under the 1 GB HALO admission budget. Docker VM memory is not
   visible as ordinary app RSS; report reservations and measured values
   separately.

## Required verification before enabling

- Fake-Docker tests verify exact argv/env/mount allowlists, immutable digest
  selection, no pull, no Docker socket, local-daemon enforcement, labels, and
  cleanup targeting.
- Planner transport tests cover oversized/truncated frames, wrong child or
  goal version, replay, timeout, process death, cancellation, and ambiguous
  browser dispatch without retry.
- Hostile container probes attempt sibling workspace/journal access, host path
  access, Docker socket access, direct network egress, browser-profile access,
  and secret discovery. Every unsupported provider and network mode must fail
  closed.
- Real Docker integration is opt-in and uses a disposable canary image and
  synthetic pages. It must confirm child A cannot observe child B's filesystem
  or browser storage and that interruption cannot delete unrelated containers.
- Measure startup and teardown failures as well as steady state. A passing
  fake-Docker suite alone is not evidence of kernel, Docker Desktop VM, or
  remote-provider isolation.

## Explicit limits

Docker Desktop, its VM, and the host kernel remain trusted. A container is not
a defense against vulnerabilities in those layers. Separate browser
partitions do not supply login credentials. MCP server containers remain a
different feature. Real provider/model execution, domain-filtered network
egress, credential brokerage, and production enablement are not complete until
their phases above have passed their own tests.
