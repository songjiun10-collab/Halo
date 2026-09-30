# Runtime TypeScript migration

The frontend uses TypeScript. The Electron runtime still loads CommonJS JavaScript,
with four shared contract modules now authored in strict TypeScript and emitted
to their existing `.js` paths. This is a scoped runtime conversion, not a claim
that the whole Electron runtime has migrated.

## Reproduce the initial audit

Install the browser package dependencies first, then from the repository root:

```sh
npm --prefix apps/computer-browser run typecheck
```

This audit uses the browser package's pinned TypeScript 6.0.2 and Node 24 types.
It checks the four TypeScript sources and compile-only type fixtures. The runtime
build configuration is separate and emits CommonJS JS only into a private temporary
directory before checking or explicitly publishing the four approved outputs.

From this directory:

```sh
npm run typecheck       # source and compile-only consumer types
npm run check:runtime   # byte-compare generated JS; never writes
npm run build:runtime   # explicit developer publication step
npm test                # check generated files, then run Node tests
npm run build            # check generated files, then build frontend
```

Only `build:runtime` writes generated JavaScript. It compiles first, validates the
exact four-file output set, rejects symlinked input/output paths, uses a private
exclusive writer lock, and replaces each file using a sibling temporary file.
The four replacements are individually atomic, not a single atomic transaction.
If interrupted, `check:runtime` reports stale files; rerun the explicit build to
repair them. A leftover lock after a crash is not deleted automatically: inspect
the named lock and remove it manually only after confirming no publisher is active.
Run the writing command while the Electron app and background service are stopped.
Direct Electron and LaunchAgent launches use checked-in JS and do not run the
freshness check themselves; run `check:runtime` before preparing those launches.

CI runs a Node 24 browser-contract check after `npm ci --ignore-scripts`, then
checks freshness, typechecks source, and runs focused tests. It does not claim a
headless Electron end-to-end run.

## Boundaries

1. Four shared contract modules now have strict TypeScript source with existing
   runtime validation retained.
2. Type the generic MCP provider/broker interface in a later phase.
3. Migrate controller and scheduler only after concurrent runtime changes settle.

Approval, journal formats, cancellation, expiry, and execution-uncertain behavior
must remain unchanged. Runtime tests and type checks are complementary; neither
replaces the other. This audit does not claim that the runtime has been converted
to TypeScript.

## Ownership and limits

The four source modules are under `runtime-src/shared/`; the existing files under
`shared/` are generated outputs. Edit the TypeScript sources and run
`npm run build:runtime` only in an offline development session with the app and
background service stopped. Do not hand-edit the generated files.
Generated files carry no source maps, so runtime stack traces report line numbers
in `shared/*.js`, which no longer match the historical hand-written files or the
TypeScript source lines.

This phase does not migrate the MCP provider/broker, controller, scheduler,
main/preload, or frontend. The npm command paths check generated artifact freshness;
direct Node and Electron invocations can bypass that check and use the checked-in
JavaScript. Compiler diagnostics are available through `npm run typecheck`; build
errors intentionally return bounded codes and point users there for details.

Phase one added strict JSDoc typing to the shared contracts and recorded an initial
154-diagnostic baseline. Phase two now uses actual TypeScript source for the four
shared modules; later runtime modules remain JavaScript.
