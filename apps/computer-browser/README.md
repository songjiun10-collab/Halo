# HALO Computer Browser

Electron browser and task runtime for HALO. The renderer presents tasks, agents,
team rooms, approval queues and browser controls. The host owns task state,
planner connections, browser execution and durable recovery.

See the [architecture guide](../../docs/ARCHITECTURE.ko.md) for component boundaries
and the [Container guide](../../deploy/container/README.ko.md) for the Docker gateway.

## Run

Run these commands from the repository root. Install a Node.js version compatible
with the pinned Electron, TypeScript and Vite packages, and Python 3.11+ for the
local approver. Planner setup is covered by the [provider guide](main/harness/providers/README.ko.md).

```sh
npm --prefix frontend ci
npm --prefix apps/computer-browser ci
npm --prefix apps/computer-browser start
```

`start` checks generated runtime files, builds the React renderer and launches
Electron. If runtime TypeScript sources changed, regenerate their JavaScript
outputs before starting:

```sh
npm --prefix apps/computer-browser run build:runtime
```

## Source ownership

| Directory | Responsibility |
| --- | --- |
| `../../frontend/` | React UI source; the app build consumes its renderer bundle |
| `main/index.js` | Electron bootstrap and production dependency wiring |
| `main/ipc.js`, `preload/` | Validated host interface exposed to the renderer |
| `main/harness/` | Task coordination, journals, planners, approval, resources and local stores |
| `runtime-src/` | TypeScript sources for migrated runtime modules |
| `shared/`, `contracts/` | Shared contracts and validation |
| `approver/` | Separate local Python approval service |
| `test/`, `integration/`, `fixtures/` | Unit tests, integration probes and benchmark fixtures |

Consult [TypeScript migration](TYPESCRIPT-MIGRATION.md) before editing generated
runtime modules and [contract conformance](contracts/README.md) before changing
persisted or cross-process data.

## Verify

```sh
npm --prefix apps/computer-browser run typecheck
npm --prefix apps/computer-browser test
npm --prefix frontend test
npm --prefix apps/computer-browser run test:renderer:e2e
```

Electron integration tests require a desktop session. Unit tests with fake
transports do not establish live provider or operating-system isolation behavior.

## Execution boundaries

The long-running path uses TaskHost → TaskController → BrowserAdapter. The legacy
ControlApi browser demo has its own lifecycle and IPC methods. The host assigns
epochs and checks policy before dispatch; planner proposals and page content are
untrusted input. Browser permission modes are `observe`, `browse`, `interact` and
`full`; MCP proposals require human approval independently of that mode.

The Electron app starts a local Python approver. Running the Docker gateway is a
separate workflow, and does not by itself place browser tasks inside containers.
Task and agent session partitions have different lifetimes; agent-bound tasks can
share an agent session. Recovery and `execution_uncertain` require review rather
than assuming an interrupted action can safely execute again.
