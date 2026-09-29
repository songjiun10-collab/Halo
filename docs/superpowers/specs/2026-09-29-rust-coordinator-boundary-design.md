# HALO Coordinator Boundary and Rust Migration Design

Status: phases 1 and 2 implemented (2026-09-29), uncommitted on `feature/routine-scheduler`, awaiting user review. Phases 3 and 4 are long-horizon and recorded here so that phases 1 and 2 fit them.

## Problem

The agent coordination logic (task lifecycle, queue, concurrency permits, resource leases, mailbox, cancellation) lives inside the Electron main process next to `WebContentsView` and CDP code. Two forces push against that:

- Coordination must survive UI crashes and Chromium memory pressure, and must keep running with no window (the background runtime service already exists).
- The state machine and durable protocol are the part where a memory-safe, single-owner implementation pays off. Browser control is not: it is bound to Electron and Chromium.

The goal is a Rust coordinator process and a Node/Electron browser/UI process. We do not want a rewrite that big-bangs: the boundary has to be proven in Node first.

## Ownership split (target end state)

Rust owns: `AgentCoordinator`, agent lifecycle and state machine, mailbox and message routing, cancellation, concurrency permits, `ResourceAdmission` and leases, timeout and backpressure, the durable event protocol (journal, checkpoints, locks, schedule and queue files).

Node/Electron owns: `WebContentsView`, Chromium lifecycle, `BrowserAdapter`, DOM/CDP, UI, provider/model bridge (planner).

Two decisions that are fixed now because they change the wire design:

1. **Single writer for durable state.** In the end state Rust is the only writer of journals, checkpoints, locks and queue/schedule files. Node reads. Until phase 4 the Node `TaskStore` remains the writer; the phase 1 corpus describes the on-disk shapes so the Rust reader/writer can be verified against real files.
2. **Request/response, coordinator-initiated.** Rust decides an action is due and sends `browser.execute` / `browser.observe` / `planner.next` requests. Node executes and answers. Node never decides scheduling. Every request carries `taskId`, a request id, a deadline and can be cancelled by id.

## Phases

### Phase 1 - Language-neutral contracts (implemented)

The JS validators in `shared/*-contracts.js` are today's only definition of the data formats. Phase 1 makes the format independent of the JS code:

- A conformance corpus under `apps/computer-browser/contracts/conformance/`: one JSON file per contract kind, each a list of `{ name, valid, value, code? }` cases. Invalid cases record the expected error `code`. Pure functions that a port must also implement (schedule due-time evaluation) get `{ name, input, expected }` cases.
- A test in the Node suite runs every case through the reference validator, so the corpus cannot drift from the JS behaviour, and a Rust port later runs the same files.
- Kinds covered: `goal_spec`, `journal_event`, `checkpoint_envelope`, `evidence`, `proposal_envelope`, `message_envelope`, `routine_definition`, `schedule_input`, `schedule_record`, and `schedule_evaluate`.
- Rule: any change to a validator must change the corpus in the same commit. The JS validator is the reference until the Rust one passes the whole corpus, after which the corpus is the reference.

Non-goals: generating code from schemas; adding a JSON Schema library.

### Phase 2 - Message boundary inside Node (implemented)

Make the coordinator depend on ports, not on concrete browser/planner objects, and prove nothing non-serialisable crosses them.

- `shared/port-contracts.js` (deep-frozen) defines `BROWSER_PORT` and `PLANNER_PORT`. Each lists four method categories:
  - `requests`: request/response calls. `signalArg` names the argument index of the options object that carries an `AbortSignal` (`observe`: 0, `execute`: 1, `planner.next`: 1).
  - `notifications`: fire-and-forget (`setPermissionMode`, `warm`). No reply, no result.
  - `mirrors`: synchronous getters (`getBrowserSnapshot`, `getDocumentEpoch`) served from state the far side pushes; the port cannot make a sync call cross the wire.
  - `events`: subscriptions (`onChange`).
  Host-only options such as `setViewport` are not part of the port.
- `main/harness/message-port.js` implements the transport, the server (`serveBrowser`, `servePlanner`) and the client (`createRemoteBrowser`, `createRemotePlanner`). The remote objects have the shape `TaskController` already accepts.
- Wire messages: `request`, `reply`, `cancel`, `notify`, `event`, `state`. Every message is passed through `jsonCopy` (`assertJsonClean` plus a JSON round trip). Undefined-valued object properties are dropped; functions, Map/Set/Date, class instances, NaN/Infinity, BigInt, Symbol, cycles and `undefined` inside arrays are rejected as `non_serializable`.
- Call semantics: every call resolves an envelope `{ ok, result }` or `{ ok:false, code, message }` and never rejects. Codes: `timeout`, `aborted`, `peer_closed`, `non_serializable`, `unknown_method`, `unsupported_method`, `remote_error`, or the far error's own `.code`. The remote wrappers translate `!ok` into a thrown `PortError(code)`. Method names are checked against the contract allowlist on the server.
- Cancellation: the `AbortSignal` is stripped from the wire and becomes a `cancel` message; the server injects a fresh `AbortSignal` at `signalArg` and aborts it on cancel. Cancel is idempotent; unknown ids are ignored. Closing the server aborts all in-flight requests.
- Mirrors: the server pushes an initial `state` message, piggybacks current state on every reply and forwards `onChange` as `event` messages. Before any state has arrived, `getDocumentEpoch()` returns `NaN`, so the observation-reuse check fails safe; `execute` additionally has a `stale_document` guard, so a stale mirror fails closed.
- The loopback pair delivers through `setImmediate`, buffers messages until a handler is registered, and `close()` fires `onClose` on both ends (in-flight calls resolve `peer_closed`).
- Acceptance (met): a `TaskHost` task runs end to end (create, observe, act, finish) with browser and planner supplied only through the loopback ports, and every wire message is asserted equal to its own JSON round trip (`test/message-port.test.js`).
- Coordinator extraction (done, narrow): `main/harness/coordinator-core.js` (`CoordinatorCore`) owns admission: the parallel cap (1 in sequential mode), the memory reserve (`MEASURED_BROWSER_TASK_RESERVE_BYTES`, scaled by the planner high-water mark), the lease ledger, the serialised admit chain and the `recoveredBlocked` gate. `TaskHost` delegates `_admitNext`, lease checks and lease release to it. Its require graph contains no Electron, browser, planner, controller or host module; `test/coordinator-core.test.js` verifies that in a child process. `TaskHost` keeps orchestration.

Non-goals: moving any code to another process; changing the on-disk formats.

### Phase 3 - Process separation (later)

Run the coordinator in the background runtime service and the browser side as a client of it over the existing unix-socket IPC (`RuntimeIpcServer` / `RuntimeIpcClient`, capability token). The phase 2 message port becomes a real socket transport with the same framing rules and timeouts. `runRoutine` and `deleteRoutine` must be added to the IPC allowlist at that point. Detaching a client must still never cancel tasks.

### Phase 4 - Port to Rust piece by piece (later)

Order, smallest and most self-contained first: `ResourceAdmission` (pure, has clear invariants), then `TaskQueue` and schedule evaluation, then the mailbox, then the task state machine, then the journal writer. For each piece: the Rust version must pass the phase 1 corpus and a behaviour-comparison test that runs the same operation trace through the Node and Rust implementations and compares results, before the Node one is removed.

## Failure semantics the wire must keep

- Timeout is a first-class result (`{ ok:false, code:"timeout" }`), never a hang. Cancel is idempotent.
- A request that was in flight when the peer died is reported as `peer_closed`; the coordinator treats it like `host_closed` in the scheduler: no failure is charged to the routine, and the occurrence is retried or adopted.
- Idempotency stays keyed by occurrence key and by message `idempotencyKey`; the transport adds nothing that weakens it (at-least-once delivery on the wire is acceptable because the receivers are idempotent).

## Testing

- Phase 1: corpus tests (reference validators pass every case; a case with a mismatched `valid`/`code` fails).
- Phase 2: port unit tests (round trip, timeout, abort, non-serialisable rejection, mirrors, `peer_closed`); an end-to-end `TaskHost` run through the ports; `CoordinatorCore` tests including a require-graph isolation check; the full existing suite unchanged.
- Fixed pre-existing race found while validating phase 2: concurrent `TaskHost.listTasks()` peeks and the load that attaches an admitted queued task collided on the task store's writer lock (`writer_conflict`), leaving the admitted task queued forever. Peeks and the attach load now share one in-process gate (`_withStoreGate`); a peek that still hits the lock reports the attached task. Regression test: "a queued task still starts while listTasks() is polled without pause".

## Open questions

- Framing for the phase 3 transport: reuse the current newline-delimited JSON or move to length-prefixed frames. Decide when phase 3 starts, using the phase 2 message sizes.
- Whether `planner.next` streams partial output. Today it does not; the port contract assumes it does not.
